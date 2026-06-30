"""Project lifecycle: create (async extraction), fetch, and EDL update."""

from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException

from ..deps import get_jobs, get_settings, get_store
from ..schemas import (
    CreateProjectRequest,
    CreateProjectResponse,
    EdlUpdate,
    ProjectView,
    to_project_view,
)
from ..workers import extract_worker
from ...models import EditDecisionList
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
        "extract",
        extract_worker(store, settings, project_id, req),
        project_id=project_id,
    )
    return CreateProjectResponse(project_id=project_id, job_id=job.id)


@router.get("/{project_id}", response_model=ProjectView)
def get_project(project_id: str, store=Depends(get_store)) -> ProjectView:
    validate_id(project_id, "project_id")
    project = store.load(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return to_project_view(project)


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
