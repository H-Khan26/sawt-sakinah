"""The opt-in yt-dlp self-update (see :mod:`sawt_sakinah.ytdlp_updates`).

* ``GET /app/ytdlp`` -> 200 :class:`YtdlpStatus`: the yt-dlp in use (bundled or updated),
  a downloaded version waiting for the next launch, and the last check's outcome.
* ``POST /app/ytdlp/check`` -> 202 with the ``update_ytdlp`` job record; a check already
  pending or running is returned as is. 409 while the ``ytdlp_update`` preference is off.

The desktop shell calls :func:`launch_check` once the service is up, which starts the same
job when the preference is on and the last check is a day old.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ... import ytdlp_updates
from ..deps import get_jobs
from ..jobs import JobKind, JobRecord, JobRegistry, JobState
from ..preferences import load_preferences

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/app/ytdlp", tags=["app"])

_LOCK = threading.Lock()


class YtdlpStatus(BaseModel):
    enabled: bool
    channel: str
    source: Optional[str] = None  # "bundled" | "updated"
    version: Optional[str] = None
    ejs_version: Optional[str] = None
    bundled_version: Optional[str] = None
    fallback: Optional[str] = None  # why a downloaded copy was not used at this launch
    pending_version: Optional[str] = None  # downloaded, used from the next launch
    latest: Optional[str] = None
    checked_at: Optional[str] = None
    error: Optional[str] = None  # the last check's failure


def start_check(app, jobs: JobRegistry) -> JobRecord:
    """Submit the check job, or return the one already pending or running."""
    with _LOCK:
        job_id = getattr(app.state, "ytdlp_check_job", None)
        record = jobs.get(job_id) if job_id else None
        if record is not None and record.state in (JobState.pending, JobState.running):
            return record
        record = jobs.submit(JobKind.update_ytdlp, ytdlp_updates.check_and_install)
        app.state.ytdlp_check_job = record.id
        return record


def launch_check(app) -> None:
    """Start the daily check when it is due; never raises."""
    try:
        if ytdlp_updates.check_due():
            start_check(app, app.state.jobs)
    except Exception:  # noqa: BLE001 - an update check must never break startup
        _log.exception("could not start the yt-dlp update check")


@router.get("", response_model=YtdlpStatus)
def get_status() -> YtdlpStatus:
    return YtdlpStatus(**ytdlp_updates.status())


@router.post("/check", response_model=JobRecord, status_code=202)
def check_now(request: Request, jobs=Depends(get_jobs)) -> JobRecord:
    if not load_preferences().ytdlp_update:
        raise HTTPException(
            status_code=409, detail="Turn on keeping the YouTube downloader up to date first."
        )
    return start_check(request.app, jobs)
