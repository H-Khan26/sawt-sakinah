"""Whisper model management: list the catalog, download a model, delete one.

The user picks the model phrase detection uses with ``PATCH /app/preferences
{"whisper_model": id}``. Status codes:

* ``GET /models`` -> 200, one :class:`WhisperModelView` per catalog model.
* ``POST /models/{id}/download`` -> 202 with the ``download_model`` job record. A download
  already pending or running for that model is returned as is (no second job); a model
  that is already installed is refused with 409 ``ModelAlreadyInstalledError``.
* ``DELETE /models/{id}`` -> 204 (also discards a partial download); 409
  ``ModelBusyError`` while it is downloading or a phrase detection is queued or running
  with it.
* An unknown id is 404 ``UnknownModelError``.
"""

from __future__ import annotations

import threading
from typing import Optional

from fastapi import APIRouter, Depends, Request, Response

from ...config import CONFIG
from ...detection import whisper_models
from ...detection.phrases import evict_model
from ..deps import get_jobs, get_settings
from ..jobs import JobKind, JobRecord, JobRegistry, JobState
from ..preferences import load_preferences
from ..schemas import WHISPER_MODELS, WhisperModelView
from ..workers import model_download_worker

router = APIRouter(prefix="/models", tags=["models"])

# Guards each app's model id -> download job id map, so a model never gets two download jobs.
_LOCK = threading.Lock()


def selected_model() -> str:
    """The user's selected model id, or the configured default when it is no longer offered."""
    choice = load_preferences().whisper_model
    return choice if choice in WHISPER_MODELS else CONFIG.phrases.model_size


def _downloads(request: Request) -> dict[str, str]:
    """The app's download job ids by model id. Call with ``_LOCK`` held."""
    downloads = getattr(request.app.state, "model_downloads", None)
    if downloads is None:
        downloads = request.app.state.model_downloads = {}
    return downloads


def _active_download(
    jobs: JobRegistry, downloads: dict[str, str], model_id: str
) -> Optional[JobRecord]:
    job_id = downloads.get(model_id)
    record = jobs.get(job_id) if job_id else None
    if record is not None and record.state in (JobState.pending, JobState.running):
        return record
    return None


@router.get("", response_model=list[WhisperModelView])
def list_models(
    request: Request, jobs=Depends(get_jobs), settings=Depends(get_settings)
) -> list[WhisperModelView]:
    selected = selected_model()
    with _LOCK:
        downloads = _downloads(request)
        active = {m: _active_download(jobs, downloads, m) for m in WHISPER_MODELS}
    return [
        WhisperModelView(
            **m,
            selected=m["id"] == selected,
            download_job_id=active[m["id"]].id if active.get(m["id"]) else None,
        )
        for m in whisper_models.list_models(settings.models_dir)
    ]


@router.post("/{model_id}/download", response_model=JobRecord, status_code=202)
def download_model(
    model_id: str, request: Request, jobs=Depends(get_jobs), settings=Depends(get_settings)
) -> JobRecord:
    entry = whisper_models.get_entry(model_id)
    with _LOCK:
        downloads = _downloads(request)
        active = _active_download(jobs, downloads, model_id)
        if active is not None:
            return active
        if whisper_models.is_installed(model_id, settings.models_dir):
            raise whisper_models.ModelAlreadyInstalledError(f"{entry.label} is already downloaded.")
        # General pool: a download must not wait behind (or block) a transcription.
        job = jobs.submit(JobKind.download_model, model_download_worker(settings, model_id))
        downloads[model_id] = job.id
    return job


@router.delete("/{model_id}", status_code=204)
def delete_model(
    model_id: str, request: Request, jobs=Depends(get_jobs), settings=Depends(get_settings)
) -> Response:
    entry = whisper_models.get_entry(model_id)
    with _LOCK:
        if _active_download(jobs, _downloads(request), model_id) is not None:
            raise whisper_models.ModelBusyError(f"{entry.label} is downloading.")
    # Outside _LOCK so listing models isn't held up by a multi-GB removal. A download
    # submitted meanwhile is refused by whichever of the two marks the model first.
    whisper_models.delete(model_id, settings.models_dir, on_remove=evict_model)
    return Response(status_code=204)
