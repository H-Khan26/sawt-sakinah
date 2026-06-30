"""Async detection endpoints (silence, phrases). Return data only -- never audio."""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException

from ..deps import get_jobs, get_settings, get_store
from ..schemas import JobAccepted, PhraseRequest, SilenceParams
from ..workers import phrases_worker, silence_worker
from .common import validate_id

router = APIRouter(prefix="/projects", tags=["detect"])


@router.post("/{project_id}/detect/silence", response_model=JobAccepted, status_code=202)
def detect_silence_endpoint(
    project_id: str,
    params: SilenceParams = Body(default_factory=SilenceParams),
    store=Depends(get_store),
    jobs=Depends(get_jobs),
    settings=Depends(get_settings),
) -> JobAccepted:
    validate_id(project_id, "project_id")
    if not store.exists(project_id):
        raise HTTPException(status_code=404, detail="project not found")
    job = jobs.submit(
        "detect_silence",
        silence_worker(store, settings, project_id, params),
        project_id=project_id,
    )
    return JobAccepted(job_id=job.id)


@router.post("/{project_id}/detect/phrases", response_model=JobAccepted, status_code=202)
def detect_phrases_endpoint(
    project_id: str,
    request: PhraseRequest = Body(default_factory=PhraseRequest),
    store=Depends(get_store),
    jobs=Depends(get_jobs),
    settings=Depends(get_settings),
) -> JobAccepted:
    validate_id(project_id, "project_id")
    if not store.exists(project_id):
        raise HTTPException(status_code=404, detail="project not found")
    # Dedicated single-worker pool: concurrent Whisper on one device OOMs.
    job = jobs.submit(
        "detect_phrases",
        phrases_worker(store, settings, project_id, request),
        project_id=project_id,
        pool="phrase",
    )
    return JobAccepted(job_id=job.id)
