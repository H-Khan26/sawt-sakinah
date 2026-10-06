"""Task bodies the job pool runs. Pure functions of (store, settings, ids, params).

Each ``*_worker`` returns a closure ``run(progress)`` that the registry executes on a
worker thread: it does the heavy work (extraction / detection / render), persists the
result through the store, and returns a small JSON-able summary that becomes the job's
``result``. Kept free of any HTTP/FastAPI types so they are testable in isolation and
reusable from a CLI. All audio writes happen here or in the editing layer -- detection
endpoints never produce files.
"""

from __future__ import annotations

import logging
import shutil
import tempfile
import threading
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING
from uuid import uuid4

from ..config import CONFIG
from ..detection import detect_phrases, detect_silence
from ..editing import render
from ..extraction import extract_audio, import_file
from ..extraction.probe import ffprobe_for
from ..extraction.probe import probe
from ..extraction.segment import write_speech_map
from ..models import (
    AudioSource,
    EditDecisionList,
    EditOperation,
    ExportArtifact,
    InvalidInputError,
    Project,
    ProjectStatus,
)
from ..prayer import derive_structure
from .jobs import TaskFn
from .projects import ProjectStore
from .schemas import (
    CreateProjectRequest,
    ExportRequest,
    PhraseRequest,
    SilenceParams,
    SplitRequest,
)
from .settings import ServiceSettings

if TYPE_CHECKING:  # pragma: no cover - typing only; segmentation needs numpy/onnxruntime
    from ..detection.segmentation import SpeechMap

_log = logging.getLogger(__name__)

# Serializes the lazy speech-map compute per project. Silence and phrase jobs for the
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


def _edl_for_range(
    edl: EditDecisionList, range_start: float, range_end: float, duration: float
) -> EditDecisionList:
    """Return ``edl`` with an added ``keep`` op restricting output to ``[range_start, range_end]``.

    The render engine intersects the keep span with the existing ``cut`` ops, so edits *inside*
    the range are still applied while everything outside it is trimmed. The source EDL is not
    mutated; a copy with the extra op is returned.
    """
    a = max(0.0, min(range_start, range_end))
    b = min(duration, max(range_start, range_end))
    keep = EditOperation(type="keep", start=a, end=b)
    return edl.model_copy(update={"operations": list(edl.operations) + [keep]})


def _range_label(range_start: float, range_end: float) -> str:
    """A compact ``m:ss-m:ss`` label for a source-time range (used in derived names)."""

    def clock(t: float) -> str:
        t = max(0.0, t)
        return f"{int(t // 60)}:{int(t % 60):02d}"

    return f"{clock(range_start)}-{clock(range_end)}"


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
    The mp3, the working copy and the speech-map sidecar all travel together.
    """
    audio_dir.mkdir(parents=True, exist_ok=True)
    updates: dict = {}
    for field in ("local_path", "working_copy", "speech_map"):
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
        source = extract_audio(
            req.url,
            output_dir=store.audio_dir(project_id),
            audio_format=req.audio_format,
            audio_quality=req.audio_quality,
            cache_dir=settings.cache_dir,
            progress_callback=progress,
        )
        return _persist_source(store, project_id, source)

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
        try:
            source = import_file(
                upload_path,
                output_dir=store.audio_dir(project_id),
                original_filename=original_filename,
                ffmpeg_bin=settings.ffmpeg_bin,
                cache_dir=settings.cache_dir,
                progress_callback=progress,
            )
            return _persist_source(store, project_id, source)
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


def phrases_worker(
    store: ProjectStore,
    settings: ServiceSettings,
    project_id: str,
    request: PhraseRequest,
) -> TaskFn:
    params = request.params

    def run(progress):
        progress({"stage": "detect", "status": "start"})
        project = store.load(project_id)
        if project is None:
            raise KeyError(project_id)
        src = project.audio_source.working_copy or project.audio_source.local_path
        # With a speech map, only the speech clips are transcribed and onsets snap to span
        # edges; without one the full file is transcribed with Whisper's own VAD filter.
        speech_map = _ensure_speech_map(store, project, settings.ffmpeg_bin)
        spans = speech_map.spans() if speech_map is not None else None
        markers = detect_phrases(
            src,
            phrases=params.phrases,
            references=request.references,
            model_size=params.model_size,
            device=params.device,
            compute_type=params.compute_type,
            language=params.language,
            min_confidence=params.min_confidence,
            min_gap_between_markers=params.min_gap_between_markers,
            max_word_gap=params.max_word_gap,
            vad_filter=params.vad_filter,
            speech_spans=spans,
            snap_window=params.snap_window,
            clip_merge_gap=params.clip_merge_gap,
            clip_pad=params.clip_pad,
            total_duration=project.audio_source.duration_sec,
            ffmpeg_bin=settings.ffmpeg_bin,
        )
        structure = derive_structure(markers, total_duration=project.audio_source.duration_sec)
        store.update(
            project_id,
            lambda p: p.model_copy(
                update={
                    "markers": markers,
                    "structure": structure,
                    "status": p.status.model_copy(update={"analyzed": True}),
                }
            ),
        )
        progress({"stage": "detect", "status": "done"})
        return {"markers": len(markers), "positions": len(structure)}

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
        # Scope to a selected range when requested: render the saved EDL plus a keep op for the
        # range (edits inside it stay applied), leaving the project's saved EDL untouched.
        scoped = req.range_start is not None and req.range_end is not None
        edl = (
            _edl_for_range(
                project.edl,
                req.range_start,
                req.range_end,
                project.audio_source.duration_sec,
            )
            if scoped
            else project.edl
        )
        # Embed the project's markers (detected + user edits) as labeled chapters. Falls
        # back to the EDL's marker ops when there are none (chapter_markers=None).
        chapter_markers = (
            [(m.time, m.label) for m in project.markers]
            if req.embed_markers and project.markers
            else None
        )
        render(
            project.audio_source,
            edl,
            out_format=req.format,
            out_path=out_path,
            ffmpeg_bin=settings.ffmpeg_bin,
            bitrate=req.bitrate,
            embed_markers=req.embed_markers,
            chapter_markers=chapter_markers,
        )
        meta = probe(out_path, ffprobe_bin=ffprobe_for(settings.ffmpeg_bin))
        default_name = project.name or None
        if scoped and not req.name:
            base = project.name or project.audio_source.title
            default_name = f"{base} ({_range_label(req.range_start, req.range_end)})"
        artifact = ExportArtifact(
            id=artifact_id,
            format=req.format,
            path=out_path,
            duration_sec=meta["duration_sec"],
            bitrate=req.bitrate,
            edl_ref=project.edl.source_id,
            name=req.name or default_name,
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
        return {"artifact_id": artifact_id}

    return run


def split_worker(
    store: ProjectStore,
    settings: ServiceSettings,
    src_project_id: str,
    new_project_id: str,
    req: SplitRequest,
) -> TaskFn:
    """Carve a source-time range out of a project into a new, independent project.

    Renders ``[range_start, range_end]`` of the source (with the source project's edits inside
    the range applied), then imports that rendered segment through the normal upload path so the
    new project gets its own audio, working copy, and empty EDL -- ready for its own detection.
    """

    def run(progress):
        progress({"stage": "render", "status": "start"})
        src = store.load(src_project_id)
        if src is None:
            raise KeyError(src_project_id)
        edl = _edl_for_range(
            src.edl, req.range_start, req.range_end, src.audio_source.duration_sec
        )
        label = _range_label(req.range_start, req.range_end)
        name = req.name or f"{src.name or src.audio_source.title} ({label})"

        with tempfile.TemporaryDirectory() as tmp:
            fmt = CONFIG.editing.out_format
            segment = Path(tmp) / f"segment.{fmt}"
            render(
                src.audio_source,
                edl,
                out_format=fmt,
                out_path=segment,
                ffmpeg_bin=settings.ffmpeg_bin,
            )
            progress({"stage": "import", "status": "start"})
            source = import_file(
                segment,
                output_dir=store.audio_dir(new_project_id),
                original_filename=f"{name}.{fmt}",
                ffmpeg_bin=settings.ffmpeg_bin,
                cache_dir=settings.cache_dir,
                progress_callback=progress,
            )
        summary = _persist_source(store, new_project_id, source, name=name)
        progress({"stage": "done", "status": "finished"})
        return summary

    return run
