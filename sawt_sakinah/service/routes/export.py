"""Async export (render the EDL) and ranged download of the resulting artifact."""

from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from ..deps import get_jobs, get_settings, get_store
from ..jobs import JobKind
from ..ranges import media_type_for, ranged_file_response
from ..schemas import ExportRequest, JobAccepted
from ..workers import export_worker
from .common import validate_id

router = APIRouter(prefix="/projects", tags=["export"])

# Strip path separators, quotes, and control chars; collapse whitespace to a single dash.
# Keeps unicode (Arabic) intact -- RFC 5987 encoding in the response handles the wire.
_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]+')


def _safe_base(text: str) -> str:
    text = _UNSAFE.sub(" ", text or "")
    text = re.sub(r"\s+", "-", text.strip())
    return text or "export"


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
        raise HTTPException(status_code=404, detail="project not found")
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
    validate_id(project_id, "project_id")
    validate_id(artifact_id, "artifact_id")
    project = store.load(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")

    artifact = next((a for a in project.exports if a.id == artifact_id), None)
    if artifact is None:
        raise HTTPException(status_code=404, detail="export not found")

    path = Path(artifact.path).resolve()
    exports_root = store.exports_dir(project_id).resolve()
    if not path.is_relative_to(exports_root) or not path.exists():
        raise HTTPException(status_code=404, detail="export not found")

    base = _safe_base(artifact.name or project.name or "export")
    filename = f"{base}-{artifact.created_at:%Y%m%d}.{artifact.format}"
    return ranged_file_response(
        path,
        request.headers.get("range"),
        media_type_for(path),
        filename=filename,
        streams=store.streams,
        key=project_id,
    )
