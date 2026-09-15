"""Task bodies the job pool runs. Pure functions of (store, settings, ids, params).

Each ``*_worker`` returns a closure ``run(progress)`` that the registry executes on a
worker thread: it does the heavy work (extraction / detection / render), persists the
result through the store, and returns a small JSON-able summary that becomes the job's
``result``. Kept free of any HTTP/FastAPI types so they are testable in isolation and
reusable from a CLI. All audio writes happen here or in the editing layer -- detection
endpoints never produce files.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from uuid import uuid4

from ..config import CONFIG
from ..detection import detect_phrases, detect_silence
from ..editing import render
from ..extraction import extract_audio, import_file
from ..extraction.probe import ffprobe_for
from ..extraction.probe import probe
from ..models import (
    AudioSource,
    EditDecisionList,
    EditOperation,
    ExportArtifact,
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


def _localize(source: AudioSource, audio_dir: Path) -> AudioSource:
    """Copy ``source``'s files into ``audio_dir`` if they live elsewhere (e.g. a cache hit).

    Keeps each project self-contained: a cache hit dedupes the expensive download/transcode
    but the project still owns its own copy, so deleting another project never strands it.
    """
    audio_dir.mkdir(parents=True, exist_ok=True)
    updates: dict = {}

    local = Path(source.local_path)
    if local.parent.resolve() != audio_dir.resolve():
        dst = audio_dir / local.name
        if not dst.exists():
            shutil.copy2(local, dst)
        updates["local_path"] = dst

    if source.working_copy is not None:
        work = Path(source.working_copy)
        if work.parent.resolve() != audio_dir.resolve():
            dst = audio_dir / work.name
            if not dst.exists():
                shutil.copy2(work, dst)
            updates["working_copy"] = dst

    return source.model_copy(update=updates) if updates else source


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
        segments = detect_silence(
            src,
            threshold_db=params.threshold_db,
            min_silence_duration=params.min_silence_duration,
            merge_gap=params.merge_gap,
            measure_loudness=params.measure_loudness,
            total_duration=project.audio_source.duration_sec,
            detector=params.detector,
            speech_threshold=params.speech_threshold,
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
        return {"silences": len(segments)}

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
        out_path = store.exports_dir(project_id) / f"{artifact_id}.{req.format}"
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
