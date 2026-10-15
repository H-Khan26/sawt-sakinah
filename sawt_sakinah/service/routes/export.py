"""Async export (render the EDL), ranged download of the resulting artifact, and, in the
desktop app, saving an export to the user's folder and showing it there."""

from __future__ import annotations

import threading
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from ...models import ExportArtifact, Project
from .. import export_folder
from ..deps import get_jobs, get_settings, get_store
from ..jobs import JobKind
from ..ranges import media_type_for, ranged_file_response
from ..schemas import ExportRequest, JobAccepted
from ..workers import export_worker
from .common import validate_id

router = APIRouter(prefix="/projects", tags=["export"])

# One save at a time, so a double click can't save the same export twice.
_SAVE_LOCK = threading.Lock()


class SavedExport(BaseModel):
    saved_path: str


def _find(store, project_id: str, artifact_id: str) -> tuple[Project, ExportArtifact]:
    validate_id(project_id, "project_id")
    validate_id(artifact_id, "artifact_id")
    project = store.load(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="recording not found")
    artifact = next((a for a in project.exports if a.id == artifact_id), None)
    if artifact is None:
        raise HTTPException(status_code=404, detail="export not found")
    return project, artifact


def _rendered_file(store, project_id: str, artifact: ExportArtifact) -> Path:
    """The project's own copy of an export; 404 unless it is inside the exports folder."""
    path = Path(artifact.path).resolve()
    exports_root = store.exports_dir(project_id).resolve()
    if artifact.external or not path.is_relative_to(exports_root) or not path.exists():
        raise HTTPException(status_code=404, detail="export not found")
    return path


@router.post("/{project_id}/export", response_model=JobAccepted, status_code=202)
def export_endpoint(
    project_id: str,
    req: ExportRequest = Body(default_factory=ExportRequest),
    store=Depends(get_store),
    jobs=Depends(get_jobs),
    settings=Depends(get_settings),
) -> JobAccepted:
    validate_id(project_id, "project_id")
    if not store.exists(project_id):
        raise HTTPException(status_code=404, detail="recording not found")
    job = jobs.submit(
        JobKind.export,
        export_worker(store, settings, project_id, req),
        project_id=project_id,
    )
    return JobAccepted(job_id=job.id)


@router.get("/{project_id}/exports/{artifact_id}")
def download_export(
    project_id: str,
    artifact_id: str,
    request: Request,
    store=Depends(get_store),
):
    project, artifact = _find(store, project_id, artifact_id)
    path = _rendered_file(store, project_id, artifact)
    base = export_folder.safe_base(artifact.name or project.name or "export")
    filename = f"{base}-{artifact.created_at:%Y%m%d}.{artifact.format}"
    return ranged_file_response(
        path,
        request.headers.get("range"),
        media_type_for(path),
        filename=filename,
        streams=store.streams,
        key=project_id,
    )


@router.post("/{project_id}/exports/{artifact_id}/save", response_model=SavedExport)
def save_export(
    project_id: str,
    artifact_id: str,
    store=Depends(get_store),
    settings=Depends(get_settings),
) -> SavedExport:
    """Move an export kept in the project (one made before exports were saved to a folder)
    into the user's export folder."""
    if not settings.export_to_folder:
        raise HTTPException(status_code=404, detail="saving to a folder needs the desktop app")

    def mutate(p: Project) -> Project:
        exports = [
            a.model_copy(update={"path": saved, "external": True}) if a.id == artifact_id else a
            for a in p.exports
        ]
        return p.model_copy(update={"exports": exports})

    with _SAVE_LOCK:
        project, artifact = _find(store, project_id, artifact_id)
        src = _rendered_file(store, project_id, artifact)
        folder = export_folder.checked_export_dir()
        name = artifact.name or project.name or "export"
        saved = export_folder.save_render(src, folder, name, artifact.format)
        store.update(project_id, mutate)
    return SavedExport(saved_path=str(saved))


@router.post("/{project_id}/exports/{artifact_id}/reveal", status_code=204)
def reveal_export(project_id: str, artifact_id: str, store=Depends(get_store)) -> Response:
    """Show the exported file selected in the OS file manager."""
    _, artifact = _find(store, project_id, artifact_id)
    path = Path(artifact.path) if artifact.external else _rendered_file(store, project_id, artifact)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="This file was moved or deleted.")
    try:
        export_folder.reveal(path)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"could not show the file: {exc}")
    return Response(status_code=204)
