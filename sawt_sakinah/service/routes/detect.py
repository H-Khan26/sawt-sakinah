"""Async detection endpoints (silence, surahs) and the surah reference table. Return data
only -- never audio."""

from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel

from ...config import CONFIG
from ...detection import quran, whisper_models
from ..deps import get_jobs, get_settings, get_store
from ..jobs import JobKind
from ..schemas import JobAccepted, SilenceParams, SurahRequest
from ..workers import silence_worker, surahs_worker
from .common import validate_id

router = APIRouter(tags=["detect"])


class SurahInfo(BaseModel):
    """One entry of ``GET /quran/surahs`` (Tanzil metadata)."""

    number: int
    name: str  # Arabic name
    tname: str  # transliteration
    ename: str  # English meaning
    ayas: int
    type: str  # "Meccan" | "Medinan"


@router.post(
    "/projects/{project_id}/detect/silence", response_model=JobAccepted, status_code=202
)
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


@router.post(
    "/projects/{project_id}/detect/surahs", response_model=JobAccepted, status_code=202
)
def detect_surahs_endpoint(
    project_id: str,
    request: SurahRequest = Body(default_factory=SurahRequest),
    store=Depends(get_store),
    jobs=Depends(get_jobs),
    settings=Depends(get_settings),
) -> JobAccepted:
    """Find the surahs recited in the recording. Answers 409 ``ModelNotInstalledError``
    when the Quran recognition model isn't downloaded, rather than queueing a job that can
    only fail."""
    validate_id(project_id, "project_id")
    if not store.exists(project_id):
        raise HTTPException(status_code=404, detail="recording not found")
    model_id = CONFIG.surahs.model
    # The model counts as in use from now until the job ends, so it can't be deleted while
    # the job waits in the queue. Marked before the install check, so a delete can't slip
    # in between.
    release = whisper_models.acquire(whisper_models.model_dir(model_id, settings.models_dir))
    try:
        whisper_models.installed_path(model_id, settings.models_dir)
        # Dedicated single-worker pool: concurrent Whisper on one device OOMs.
        job = jobs.submit(
            JobKind.detect_surahs,
            surahs_worker(store, settings, project_id, model_id, request),
            project_id=project_id,
            pool="transcription",
            on_finish=release,
        )
    except BaseException:
        release()
        raise
    return JobAccepted(job_id=job.id)


@router.get("/quran/surahs", response_model=list[SurahInfo])
def list_surahs() -> list[SurahInfo]:
    """The 114 surahs with their names and ayah counts, for labelling passages."""
    return [SurahInfo(**vars(s)) for s in quran.surahs()]
