"""Async detection endpoints (silence, phrases). Return data only -- never audio."""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException

from ...detection import whisper_models
from ..deps import get_jobs, get_settings, get_store
from ..jobs import JobKind
from ..schemas import JobAccepted, PhraseRequest, SilenceParams
from ..workers import phrases_worker, silence_worker
from .common import validate_id
from .models import selected_model

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
        raise HTTPException(status_code=404, detail="recording not found")
    job = jobs.submit(
        JobKind.detect_silence,
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
        raise HTTPException(status_code=404, detail="recording not found")
    # Pin the job to a concrete model and fail fast (409 ModelNotInstalledError) when it
    # isn't downloaded, rather than queueing a job that can only fail.
    model_id = request.params.model_size or selected_model()
    params = request.params.model_copy(update={"model_size": model_id})
    request = request.model_copy(update={"params": params})
    # The model counts as in use from now until the job ends, so it can't be deleted while
    # the job waits in the queue. Marked before the install check, so a delete can't slip
    # in between.
    release = whisper_models.acquire(whisper_models.model_dir(model_id, settings.models_dir))
    try:
        whisper_models.installed_path(model_id, settings.models_dir)
        # Dedicated single-worker pool: concurrent Whisper on one device OOMs.
        job = jobs.submit(
            JobKind.detect_phrases,
            phrases_worker(store, settings, project_id, request),
            project_id=project_id,
            pool="phrase",
            on_finish=release,
        )
    except BaseException:
        release()
        raise
    return JobAccepted(job_id=job.id)
