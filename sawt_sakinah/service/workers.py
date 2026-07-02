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
from pathlib import Path
from uuid import uuid4

from ..detection import detect_phrases, detect_silence
from ..editing import render
from ..extraction import extract_audio
from ..extraction.probe import ffprobe_for
from ..extraction.probe import probe
from ..models import (
    AudioSource,
    EditDecisionList,
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
)
from .settings import ServiceSettings


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
        source = _localize(source, store.audio_dir(project_id))
        project = Project(
            id=project_id,
            audio_source=source,
            name=source.title,
            edl=EditDecisionList(source_id=source.id),
            status=ProjectStatus(extracted=True),
        )
        store.create(project)
        return {"project_id": project_id, "duration_sec": source.duration_sec}

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
        # Embed the project's markers (detected + user edits) as labeled chapters. Falls
        # back to the EDL's marker ops when there are none (chapter_markers=None).
        chapter_markers = (
            [(m.time, m.label) for m in project.markers]
            if req.embed_markers and project.markers
            else None
        )
        render(
            project.audio_source,
            project.edl,
            out_format=req.format,
            out_path=out_path,
            ffmpeg_bin=settings.ffmpeg_bin,
            bitrate=req.bitrate,
            embed_markers=req.embed_markers,
            chapter_markers=chapter_markers,
        )
        meta = probe(out_path, ffprobe_bin=ffprobe_for(settings.ffmpeg_bin))
        artifact = ExportArtifact(
            id=artifact_id,
            format=req.format,
            path=out_path,
            duration_sec=meta["duration_sec"],
            bitrate=req.bitrate,
            edl_ref=project.edl.source_id,
            name=req.name or project.name or None,
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
