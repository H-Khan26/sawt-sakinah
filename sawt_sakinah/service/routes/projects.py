"""Project lifecycle: create (async extraction), list, fetch, rename, delete, and the
EDL / marker updates."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile

from ...config import CONFIG
from ..deps import get_jobs, get_settings, get_store
from ..jobs import JobKind, JobQueueFullError
from ..schemas import (
    CreateProjectRequest,
    CreateProjectResponse,
    EdlUpdate,
    MarkersUpdate,
    PatchProjectRequest,
    ProjectListResponse,
    ProjectView,
    SplitRequest,
    to_project_view,
)
from ..workers import extract_worker, import_worker, split_worker
from ...models import EditDecisionList
from ...models.errors import FileTooLargeError, UnsupportedMediaError
from ...prayer import derive_structure
from .common import validate_id

# Read uploads in 1 MiB chunks so a large file never loads wholesale into memory.
_UPLOAD_CHUNK = 1024 * 1024

router = APIRouter(prefix="/projects", tags=["projects"])


def _submit_new_project(jobs, store, project_id: str, kind: JobKind, fn):
    """Submit the job that fills a freshly prepared project. The project folder is removed
    if the queue refuses the job, or if the job ends (failed, stopped or dropped at
    shutdown) without writing ``project.json``, so no empty skeleton is left behind."""
    try:
        return jobs.submit(
            kind,
            fn,
            project_id=project_id,
            on_finish=lambda: store.discard_unfinished(project_id),
        )
    except JobQueueFullError:
        store.delete(project_id)
        raise


@router.post("", response_model=CreateProjectResponse, status_code=202)
def create_project(
    req: CreateProjectRequest,
    store=Depends(get_store),
    jobs=Depends(get_jobs),
    settings=Depends(get_settings),
) -> CreateProjectResponse:
    """Create a project directory and kick off extraction; ``project.json`` is written
    by the extract job once the ``AudioSource`` exists (``GET /projects/{id}`` 404s until
    then)."""
    jobs.ensure_capacity()
    project_id = uuid4().hex
    store.prepare(project_id)
    job = _submit_new_project(
        jobs, store, project_id, JobKind.extract, extract_worker(store, settings, project_id, req)
    )
    return CreateProjectResponse(project_id=project_id, job_id=job.id)


@router.post("/upload", response_model=CreateProjectResponse, status_code=202)
async def upload_project(
    file: UploadFile = File(...),
    store=Depends(get_store),
    jobs=Depends(get_jobs),
    settings=Depends(get_settings),
) -> CreateProjectResponse:
    """Ingest an uploaded media file: stream it to disk (size-capped), then kick off the
    transcode job. Symmetric with ``POST /projects`` (URL) -- both return a project + job id
    and write ``project.json`` from the worker once the ``AudioSource`` exists.

    The extension is checked here at the edge; ffmpeg-decodability and the audio-stream
    check happen in the worker (surfacing via ``JobRecord.error_type``).
    """
    ext = Path(file.filename or "").suffix.lower()
    if ext not in CONFIG.extraction.allowed_upload_extensions:
        allowed = ", ".join(CONFIG.extraction.allowed_upload_extensions)
        raise UnsupportedMediaError(
            f"'{file.filename or 'file'}' is not a supported file type. Accepted: {allowed}."
        )

    jobs.ensure_capacity()
    project_id = uuid4().hex
    store.prepare(project_id)
    staging = store.audio_dir(project_id) / f"upload{ext}"
    max_bytes = CONFIG.extraction.max_upload_mb * 1024 * 1024

    try:
        written = 0
        with open(staging, "wb") as fh:
            while chunk := await file.read(_UPLOAD_CHUNK):
                written += len(chunk)
                if written > max_bytes:
                    raise FileTooLargeError(
                        f"Upload exceeds the {CONFIG.extraction.max_upload_mb} MB limit."
                    )
                fh.write(chunk)
    except FileTooLargeError:
        store.delete(project_id)  # drops the whole skeleton, including the partial staging file
        raise
    finally:
        await file.close()

    job = _submit_new_project(
        jobs,
        store,
        project_id,
        JobKind.extract,
        import_worker(store, settings, project_id, staging, file.filename or staging.name),
    )
    return CreateProjectResponse(project_id=project_id, job_id=job.id)


@router.post("/{project_id}/split", response_model=CreateProjectResponse, status_code=202)
def split_project(
    project_id: str,
    req: SplitRequest,
    store=Depends(get_store),
    jobs=Depends(get_jobs),
    settings=Depends(get_settings),
) -> CreateProjectResponse:
    """Carve a source-time range out of a project into a new, independent project.

    Renders the range (edits inside it applied) and imports it as a fresh project, mirroring
    ``POST /projects``: returns the new project + job id, and ``project.json`` is written by
    the job once the segment has been rendered and imported."""
    validate_id(project_id, "project_id")
    if not store.exists(project_id):
        raise HTTPException(status_code=404, detail="project not found")
    jobs.ensure_capacity()
    new_id = uuid4().hex
    store.prepare(new_id)
    job = _submit_new_project(
        jobs, store, new_id, JobKind.split, split_worker(store, settings, project_id, new_id, req)
    )
    return CreateProjectResponse(project_id=new_id, job_id=job.id)


@router.get("", response_model=ProjectListResponse)
def list_projects(store=Depends(get_store)) -> ProjectListResponse:
    """The library list: lightweight summaries, most-recently-edited first."""
    return ProjectListResponse(projects=store.list_summaries())


@router.get("/{project_id}", response_model=ProjectView)
def get_project(project_id: str, store=Depends(get_store)) -> ProjectView:
    validate_id(project_id, "project_id")
    project = store.load(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return to_project_view(project)


@router.patch("/{project_id}", response_model=ProjectView)
def patch_project(
    project_id: str,
    req: PatchProjectRequest,
    store=Depends(get_store),
) -> ProjectView:
    """Rename the project. Returns the full ``ProjectView`` so the client patches its
    cache in one shot (same convention as ``PUT /markers``)."""
    validate_id(project_id, "project_id")
    try:
        updated = store.rename(project_id, req.name)
    except KeyError:
        raise HTTPException(status_code=404, detail="project not found")
    return to_project_view(updated)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: str, store=Depends(get_store)) -> Response:
    """Delete the project. Answers 409 (``ProjectInUseError``) when its files stay locked,
    in which case nothing was removed."""
    validate_id(project_id, "project_id")
    if not store.delete(project_id):
        raise HTTPException(status_code=404, detail="project not found")
    return Response(status_code=204)


@router.put("/{project_id}/edl", response_model=EditDecisionList)
def put_edl(
    project_id: str,
    update: EdlUpdate,
    store=Depends(get_store),
) -> EditDecisionList:
    """Replace the EDL operations (no render); export renders the saved EDL later."""
    validate_id(project_id, "project_id")

    def mutate(p):
        edl = p.edl.model_copy(
            update={
                "operations": update.operations,
                "updated_at": datetime.now(timezone.utc),
            }
        )
        return p.model_copy(update={"edl": edl})

    try:
        updated = store.update(project_id, mutate)
    except KeyError:
        raise HTTPException(status_code=404, detail="project not found")
    return updated.edl


@router.put("/{project_id}/markers", response_model=ProjectView)
def put_markers(
    project_id: str,
    update: MarkersUpdate,
    store=Depends(get_store),
) -> ProjectView:
    """Replace the marker list and re-derive prayer structure (no render).

    Structure is a pure function of the markers, so it is recomputed here rather than
    accepted from the client. Returns the full project so the client can patch its cache
    with both the new markers and structure in one shot.
    """
    validate_id(project_id, "project_id")

    def mutate(p):
        structure = derive_structure(
            update.markers, total_duration=p.audio_source.duration_sec
        )
        return p.model_copy(
            update={
                "markers": list(update.markers),
                "structure": structure,
                "status": p.status.model_copy(update={"analyzed": True}),
            }
        )

    try:
        updated = store.update(project_id, mutate)
    except KeyError:
        raise HTTPException(status_code=404, detail="project not found")
    return to_project_view(updated)
