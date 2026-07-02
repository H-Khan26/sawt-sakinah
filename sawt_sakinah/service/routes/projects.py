"""Project lifecycle: create (async extraction), list, fetch, rename, delete, and the
EDL / marker updates."""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Response

from ..deps import get_jobs, get_settings, get_store
from ..jobs import JobKind
from ..schemas import (
    CreateProjectRequest,
    CreateProjectResponse,
    EdlUpdate,
    MarkersUpdate,
    PatchProjectRequest,
    ProjectListResponse,
    ProjectView,
    to_project_view,
)
from ..workers import extract_worker
from ...models import EditDecisionList
from ...prayer import derive_structure
from .common import validate_id

router = APIRouter(prefix="/projects", tags=["projects"])


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
    project_id = uuid4().hex
    store.prepare(project_id)
    job = jobs.submit(
        JobKind.extract,
        extract_worker(store, settings, project_id, req),
        project_id=project_id,
    )
    return CreateProjectResponse(project_id=project_id, job_id=job.id)


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
