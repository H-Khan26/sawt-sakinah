"""Task bodies the job pool runs. Pure functions of (store, settings, ids, params).

Each ``*_worker`` returns a closure ``run(progress)`` that the registry executes on a
worker thread: it does the heavy work (extraction / detection / render), persists the
result through the store, and returns a small JSON-able summary that becomes the job's
``result``. Kept free of any HTTP/FastAPI types so they are testable in isolation and
reusable from a CLI. All audio writes happen here or in the editing layer -- detection
endpoints never produce files.

A job removes the partial output it owns when it fails or is stopped at shutdown: an
export renders to ``<id>.part.<ext>`` and is renamed into place only once complete (in the
desktop app it is then moved to the user's export folder; see ``export_folder.py``). The
half-built folder of a job creating a project (download, upload, split) is removed by the
route's ``on_finish`` hook (``ProjectStore.discard_unfinished``), which also covers a job
dropped from the queue. What a hard exit still leaves behind is removed by
``ProjectStore.sweep`` at the next start.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
import threading
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

from ..config import CONFIG
from ..detection import detect_silence, match_surahs, quran, whisper_models
from ..detection.transcribe import Word, load_transcript, save_transcript, transcribe
from ..editing import render
from ..extraction import extract_audio, import_file
from ..extraction.probe import probe
from ..extraction.segment import write_speech_map
from ..fileio import part_path, replace_file
from ..models import (
    AudioSource,
    EditDecisionList,
    EditOperation,
    ExportArtifact,
    InvalidInputError,
    Project,
    ProjectStatus,
    SurahMap,
    SurahPassage,
)
from . import export_folder
from .jobs import TaskFn
from .preferences import load_preferences
from .projects import ProjectStore
from .schemas import (
    CreateProjectRequest,
    ExportRequest,
    SilenceParams,
    SplitRequest,
    SurahRequest,
)
from .settings import ServiceSettings
from .timing import StageTimer

if TYPE_CHECKING:  # pragma: no cover - typing only; segmentation needs numpy/onnxruntime
    from ..detection.segmentation import SpeechMap

_log = logging.getLogger(__name__)

# Serializes the lazy speech-map compute per project. Silence and surah jobs for the
# same project run on different pools, so without this both could pay for the Silero
# pass and race to write the same sidecar. Distinct from ``ProjectStore``'s lock, which
# only guards the short project.json read-modify-write and must not be held for seconds.
_SPEECH_MAP_LOCKS: dict[str, threading.Lock] = {}
_SPEECH_MAP_LOCKS_GUARD = threading.Lock()


def _speech_map_lock(project_id: str) -> threading.Lock:
    """Return the per-project lock guarding speech-map load/compute."""
    with _SPEECH_MAP_LOCKS_GUARD:
        lock = _SPEECH_MAP_LOCKS.get(project_id)
        if lock is None:
            lock = threading.Lock()
            _SPEECH_MAP_LOCKS[project_id] = lock
        return lock


def _edl_for_ranges(
    edl: EditDecisionList, ranges: list[tuple[float, float]], duration: float
) -> EditDecisionList:
    """Return ``edl`` with added ``keep`` ops restricting output to ``ranges``.

    The render engine keeps the union of the keep spans and subtracts the existing ``cut``
    ops, so edits *inside* the ranges are still applied while everything outside them is
    trimmed and the ranges play back to back. The source EDL is not mutated; a copy with
    the extra ops is returned.
    """
    keeps = [
        EditOperation(type="keep", start=max(0.0, min(a, b)), end=min(duration, max(a, b)))
        for a, b in ranges
    ]
    return edl.model_copy(update={"operations": list(edl.operations) + keeps})


def _clock(t: float) -> str:
    t = max(0.0, t)
    return f"{int(t // 60)}:{int(t % 60):02d}"


def _ranges_label(ranges: list[tuple[float, float]]) -> str:
    """A compact ``m:ss-m:ss`` label for source-time ranges (used in derived names); several
    ranges read as their overall extent plus the count, e.g. ``1:05-9:40, 3 parts``."""
    label = f"{_clock(ranges[0][0])}-{_clock(ranges[-1][1])}"
    return label if len(ranges) == 1 else f"{label}, {len(ranges)} parts"


def _chapter_title(passage: SurahPassage) -> str:
    """``"Al-Hajj · 1–24"``, or ``"Al-Hajj · 5"`` for a single ayah."""
    ayat = str(passage.ayah_from)
    if passage.ayah_to != passage.ayah_from:
        ayat += f"–{passage.ayah_to}"
    return f"{quran.surah(passage.surah).tname} · {ayat}"


def _copy_into(path: Path | None, audio_dir: Path) -> Path | None:
    """Copy ``path`` into ``audio_dir`` unless it already lives there.

    Returns the new location when a move is needed, else ``None`` (nothing to update).
    An existing file of the same name is reused rather than overwritten.
    """
    if path is None:
        return None
    src = Path(path)
    if src.parent.resolve() == audio_dir.resolve():
        return None
    dst = audio_dir / src.name
    if not dst.exists():
        shutil.copy2(src, dst)
    return dst


def _localize(source: AudioSource, audio_dir: Path) -> AudioSource:
    """Copy ``source``'s files into ``audio_dir`` if they live elsewhere (e.g. a cache hit).

    Keeps each project self-contained: a cache hit dedupes the expensive download/transcode
    but the project still owns its own copy, so deleting another project never strands it.
    The mp3, the working copy and the speech-map and transcript sidecars travel together.
    """
    audio_dir.mkdir(parents=True, exist_ok=True)
    updates: dict = {}
    for field in ("local_path", "working_copy", "speech_map", "transcript"):
        moved = _copy_into(getattr(source, field), audio_dir)
        if moved is not None:
            updates[field] = moved
    return source.model_copy(update=updates) if updates else source


def _ensure_speech_map(
    store: ProjectStore, project: Project, ffmpeg_bin: str = CONFIG.ffmpeg.bin
) -> "SpeechMap | None":
    """Return the project's speech map, computing and persisting it when absent or unusable.

    Sources created before the sidecar existed (or whose sidecar was healed away) get it
    on first speech-aware detect; the new path is written back through ``store.update``
    so later jobs load it directly. A sidecar that cannot be read (corrupt, truncated,
    missing keys) or that was produced by a different model version is recomputed in
    place rather than failing the job. Returns ``None`` when there is no working copy to
    derive it from or the ``vad`` extra (onnxruntime) is not installed, in which case the
    callers fall back to speech-unaware behaviour.

    The whole body runs under the project's speech-map lock, and the project is
    re-loaded inside it: a concurrent job for the same project may have just finished
    the compute, in which case its sidecar is loaded instead of being redone. The store
    already heals a missing file to ``None`` on load, so no existence check is needed.
    ``store.update`` is only entered for the path write, never around the compute.
    """
    from ..detection import segmentation
    from ..detection.segmentation import SpeechMap

    with _speech_map_lock(project.id):
        current = store.load(project.id)
        if current is not None:
            project = current
        src = project.audio_source
        if src.speech_map is not None:
            try:
                speech_map = SpeechMap.load(src.speech_map)
            except (OSError, ValueError, KeyError, EOFError, zipfile.BadZipFile) as err:
                _log.warning(
                    "speech map for project %s is unreadable (%s); recomputing", project.id, err
                )
            else:
                if speech_map.model_version == segmentation.MODEL_VERSION:
                    return speech_map
                _log.warning(
                    "speech map for project %s was produced by %s, current model is %s; recomputing",
                    project.id,
                    speech_map.model_version,
                    segmentation.MODEL_VERSION,
                )
        if src.working_copy is None:
            return None
        try:
            path = write_speech_map(
                src.working_copy, output_path=src.speech_map, ffmpeg_bin=ffmpeg_bin
            )
        except ImportError as err:
            _log.warning("speech map unavailable for project %s: %s", project.id, err)
            return None
        store.update(
            project.id,
            lambda p: p.model_copy(
                update={"audio_source": p.audio_source.model_copy(update={"speech_map": path})}
            ),
        )
        return SpeechMap.load(path)


def _persist_source(
    store: ProjectStore,
    project_id: str,
    source: AudioSource,
    name: str | None = None,
) -> dict:
    """Localize an acquired source into the project and create ``project.json``.

    The tail shared by both acquisition workers (download / upload) and the split worker: copy
    the source's files into the project (a no-op unless a cache hit points elsewhere), assemble
    a fresh ``Project``, persist it, and return the job's summary. Source-kind-agnostic.
    ``name`` overrides the library label (defaults to the source title).
    """
    source = _localize(source, store.audio_dir(project_id))
    project = Project(
        id=project_id,
        audio_source=source,
        name=name or source.title,
        edl=EditDecisionList(source_id=source.id),
        status=ProjectStatus(extracted=True),
    )
    store.create(project)
    return {"project_id": project_id, "duration_sec": source.duration_sec}


def extract_worker(
    store: ProjectStore,
    settings: ServiceSettings,
    project_id: str,
    req: CreateProjectRequest,
) -> TaskFn:
    def run(progress):
        timer = StageTimer(progress)
        # Read at run time, so a cookies change in Settings applies to the next try.
        prefs = load_preferences()
        source = extract_audio(
            req.url,
            output_dir=store.audio_dir(project_id),
            audio_format=req.audio_format,
            audio_quality=req.audio_quality,
            cache_dir=settings.cache_dir,
            ffmpeg_bin=settings.ffmpeg_bin,
            ffprobe_bin=settings.ffprobe_bin,
            progress_callback=timer,
            cookies_from_browser=prefs.cookies_browser,
            cookies_file=prefs.cookies_file,
        )
        timer.mark("persist")
        result = _persist_source(store, project_id, source)
        result["timings"] = timer.finish("download", source.duration_sec)
        return result

    return run


def import_worker(
    store: ProjectStore,
    settings: ServiceSettings,
    project_id: str,
    upload_path: Path,
    original_filename: str,
) -> TaskFn:
    """Ingest a staged upload: transcode -> AudioSource -> project. Mirrors ``extract_worker``.

    ``upload_path`` is the raw file the route streamed to disk; it is removed once the
    canonical artifact has been transcoded (or on failure) since the project keeps only the
    transcoded mp3 + working copy.
    """

    def run(progress):
        timer = StageTimer(progress)
        try:
            source = import_file(
                upload_path,
                output_dir=store.audio_dir(project_id),
                original_filename=original_filename,
                ffmpeg_bin=settings.ffmpeg_bin,
                ffprobe_bin=settings.ffprobe_bin,
                cache_dir=settings.cache_dir,
                progress_callback=timer,
            )
            timer.mark("persist")
            result = _persist_source(store, project_id, source)
            result["timings"] = timer.finish("upload", source.duration_sec)
            return result
        finally:
            try:
                Path(upload_path).unlink(missing_ok=True)
            except OSError:
                pass  # best-effort staging cleanup; never mask the real result/error

    return run


def silence_worker(
    store: ProjectStore,
    settings: ServiceSettings,
    project_id: str,
    params: SilenceParams,
) -> TaskFn:
    def run(progress):
        progress({"stage": "detect", "status": "start"})
        project = store.load(project_id)
        if project is None:
            raise KeyError(project_id)
        src = project.audio_source.working_copy or project.audio_source.local_path
        # Only the speech-aware detector needs the map, so the energy gate never pays for
        # (or waits on) a Silero pass. Without a map (no onnxruntime, or no working copy)
        # degrade to the energy gate instead of failing the job, and say so.
        detector = params.detector
        speech_map = (
            _ensure_speech_map(store, project, settings.ffmpeg_bin)
            if detector == "vad"
            else None
        )
        result: dict = {}
        if detector == "vad" and speech_map is None:
            detector = "ffmpeg"
            result.update({"detector": "ffmpeg", "fallback": "vad unavailable"})
        segments = detect_silence(
            src,
            threshold_db=params.threshold_db,
            min_silence_duration=params.min_silence_duration,
            merge_gap=params.merge_gap,
            measure_loudness=params.measure_loudness,
            total_duration=project.audio_source.duration_sec,
            detector=detector,
            speech_threshold=params.speech_threshold,
            min_speech_duration=params.min_speech_duration,
            speech_map=speech_map,
            ffmpeg_bin=settings.ffmpeg_bin,
            ffprobe_bin=settings.ffprobe_bin,
        )
        store.update(
            project_id,
            lambda p: p.model_copy(
                update={
                    "silences": segments,
                    "status": p.status.model_copy(update={"analyzed": True}),
                }
            ),
        )
        progress({"stage": "detect", "status": "done"})
        result["silences"] = len(segments)
        return result

    return run


def _saved_words(project: Project, model_id: str) -> list[Word] | None:
    """The project's transcript sidecar words when they came from ``model_id``, else
    ``None`` (none saved, another model, or unreadable)."""
    path = project.audio_source.transcript
    if path is None:
        return None
    try:
        model, words = load_transcript(path)
    except (OSError, ValueError) as err:
        _log.warning("transcript for project %s is unreadable (%s); transcribing", project.id, err)
        return None
    return words if model == model_id else None


def surahs_worker(
    store: ProjectStore,
    settings: ServiceSettings,
    project_id: str,
    model_id: str,
    request: SurahRequest,
) -> TaskFn:
    """Transcribe the recording (or reuse its saved transcript) and match it to the Quran.

    Progress payloads are ``{"stage": "detect", "status": "start"}``, then
    ``{"stage": "transcribing", "done_sec", "total_sec"}`` while Whisper runs (seconds of speech handed to it), ``{"stage": "matching"}``, then the
    terminal ``{"stage": "detect", "status": "done"}``. The transcript is saved as the
    ``audio/transcript.json`` sidecar before matching, so re-matching never transcribes
    again. The result counts the passages by level.
    """

    def run(progress):
        progress({"stage": "detect", "status": "start"})
        project = store.load(project_id)
        if project is None:
            raise KeyError(project_id)
        source = project.audio_source
        src = source.working_copy or source.local_path
        # With a speech map only the speech clips are transcribed and passage edges snap
        # to span edges; without one the full file is transcribed with Whisper's own VAD.
        speech_map = _ensure_speech_map(store, project, settings.ffmpeg_bin)
        spans = (
            speech_map.spans(bridge_gap=CONFIG.surahs.bridge_gap)
            if speech_map is not None
            else None
        )
        words = _saved_words(project, model_id) if request.reuse_transcript else None
        if words is None:
            words = transcribe(
                src,
                model=model_id,
                models_dir=settings.models_dir,
                speech_spans=spans,
                total_duration=source.duration_sec,
                ffmpeg_bin=settings.ffmpeg_bin,
                progress=progress,
            )
            path = save_transcript(store.audio_dir(project_id) / "transcript.json", model_id, words)
            store.update(
                project_id,
                lambda p: p.model_copy(
                    update={"audio_source": p.audio_source.model_copy(update={"transcript": path})}
                ),
            )
        progress({"stage": "matching"})
        passages = match_surahs(words, speech_spans=spans, total_duration=source.duration_sec)
        surah_map = SurahMap(
            model=model_id, matched_at=datetime.now(timezone.utc), passages=passages
        )
        store.update(
            project_id,
            lambda p: p.model_copy(
                update={
                    "surahs": surah_map,
                    "status": p.status.model_copy(update={"analyzed": True}),
                }
            ),
        )
        progress({"stage": "detect", "status": "done"})
        return {
            "passages": len(passages),
            "accept": sum(1 for x in passages if x.level == "accept"),
            "unsure": sum(1 for x in passages if x.level == "unsure"),
        }

    return run


def model_download_worker(settings: ServiceSettings, model_id: str) -> TaskFn:
    """Download a catalog Whisper model into ``settings.models_dir`` (resumes a partial one).

    Progress payloads are ``{"stage": "downloading", "bytes_done", "bytes_total"}``.
    """

    def run(progress):
        whisper_models.download(model_id, settings.models_dir, progress=progress)
        return {"model_id": model_id}

    return run


def export_worker(
    store: ProjectStore,
    settings: ServiceSettings,
    project_id: str,
    req: ExportRequest,
) -> TaskFn:
    def run(progress):
        progress({"stage": "export", "status": "start"})
        project = store.load(project_id)
        if project is None:
            raise KeyError(project_id)
        artifact_id = uuid4().hex
        exports_root = store.exports_dir(project_id).resolve()
        out_path = (exports_root / f"{artifact_id}.{req.format}").resolve()
        # Defence in depth behind the schema's format allow-list: never write outside the
        # project's exports folder.
        if out_path.parent != exports_root:
            raise InvalidInputError(f"invalid export format: {req.format!r}")
        # Checked before rendering, so a blocked or missing folder fails in a moment.
        folder = export_folder.checked_export_dir() if settings.export_to_folder else None
        # Scope to a selected range when requested: render the saved EDL plus a keep op for the
        # range (edits inside it stay applied), leaving the project's saved EDL untouched.
        scoped = req.range_start is not None and req.range_end is not None
        edl = (
            _edl_for_ranges(
                project.edl,
                [(req.range_start, req.range_end)],
                project.audio_source.duration_sec,
            )
            if scoped
            else project.edl
        )
        # Accepted surah passages become chapters, e.g. "Al-Hajj · 1–24"; unsure
        # ones don't.
        chapters = (
            [
                (x.start, x.end, _chapter_title(x))
                for x in project.surahs.passages
                if x.level == "accept"
            ]
            if req.embed_chapters and project.surahs is not None
            else None
        )
        # Rendered under a partial name so an interrupted export never looks finished.
        partial = part_path(out_path)
        try:
            render(
                project.audio_source,
                edl,
                out_format=req.format,
                out_path=partial,
                ffmpeg_bin=settings.ffmpeg_bin,
                ffprobe_bin=settings.ffprobe_bin,
                bitrate=req.bitrate,
                embed_chapters=req.embed_chapters,
                chapters=chapters,
            )
            meta = probe(partial, ffprobe_bin=settings.ffprobe_bin)
            replace_file(partial, out_path)
        except BaseException:
            try:
                partial.unlink(missing_ok=True)
            except OSError as exc:
                _log.warning("could not remove the partial export %s: %s", partial, exc)
            raise
        default_name = project.name or None
        if scoped and not req.name:
            base = project.name or project.audio_source.title
            default_name = f"{base} ({_ranges_label([(req.range_start, req.range_end)])})"
        name = req.name or default_name
        saved = save_error = None
        if folder is not None:
            try:
                saved = export_folder.save_render(out_path, folder, name or "export", req.format)
            except export_folder.ExportFolderError as exc:
                # The render stays in the project, where "Save to folder" can retry it.
                save_error = str(exc)
        artifact = ExportArtifact(
            id=artifact_id,
            format=req.format,
            path=saved or out_path,
            duration_sec=meta["duration_sec"],
            bitrate=req.bitrate,
            edl_ref=project.edl.source_id,
            name=name,
            external=saved is not None,
        )
        store.update(
            project_id,
            lambda p: p.model_copy(
                update={
                    "exports": list(p.exports) + [artifact],
                    "status": p.status.model_copy(update={"edited": True}),
                }
            ),
        )
        progress({"stage": "export", "status": "done"})
        return {
            "artifact_id": artifact_id,
            "saved_path": str(saved) if saved else None,
            "save_error": save_error,
        }

    return run


def split_worker(
    store: ProjectStore,
    settings: ServiceSettings,
    src_project_id: str,
    new_project_id: str,
    req: SplitRequest,
) -> TaskFn:
    """Copy source-time ranges of a project into a new, independent project.

    Renders ``req.ranges`` of the source back to back (with the source project's edits inside
    them applied), then imports that rendered audio through the normal upload path so the new
    project gets its own audio, working copy, and empty EDL -- ready for its own detection.
    """

    def run(progress):
        progress({"stage": "render", "status": "start"})
        src = store.load(src_project_id)
        if src is None:
            raise KeyError(src_project_id)
        edl = _edl_for_ranges(src.edl, req.ranges, src.audio_source.duration_sec)
        label = _ranges_label(req.ranges)
        name = req.name or f"{src.name or src.audio_source.title} ({label})"

        # A helper killed at shutdown may still hold the segment; never fail on cleanup.
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
            fmt = CONFIG.editing.out_format
            segment = Path(tmp) / f"segment.{fmt}"
            render(
                src.audio_source,
                edl,
                out_format=fmt,
                out_path=segment,
                ffmpeg_bin=settings.ffmpeg_bin,
                ffprobe_bin=settings.ffprobe_bin,
            )
            progress({"stage": "import", "status": "start"})
            source = import_file(
                segment,
                output_dir=store.audio_dir(new_project_id),
                original_filename=f"{name}.{fmt}",
                ffmpeg_bin=settings.ffmpeg_bin,
                ffprobe_bin=settings.ffprobe_bin,
                cache_dir=settings.cache_dir,
                progress_callback=progress,
            )
        summary = _persist_source(store, new_project_id, source, name=name)
        progress({"stage": "done", "status": "finished"})
        return summary

    return run
