"""The opt-in yt-dlp self-update (see :mod:`sawt_sakinah.ytdlp_updates`).

* ``GET /app/ytdlp`` -> 200 :class:`YtdlpStatus`: the yt-dlp in use (bundled or updated),
  a downloaded version waiting for the next launch, the last check's outcome, and the
  check job running now, if any.
* ``POST /app/ytdlp/check`` -> 202 with the ``update_ytdlp`` job record; a check already
  pending or running is returned as is. 409 while the ``ytdlp_update`` preference is off.

The desktop shell calls :func:`launch_check` once the service is up, and the preferences
route calls :func:`preference_changed` when the option is turned on; both start the same
job when the last check is a day old. The job runs on the registry's background pool so
it never delays a user's import or export.
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
    # Why the active (or waiting) yt-dlp can't impersonate with the app's curl_cffi.
    curl_cffi_conflict: Optional[str] = None
    check_job_id: Optional[str] = None  # the check pending or running now
    check_state: Optional[str] = None


def _current_check(app, jobs: JobRegistry) -> Optional[JobRecord]:
    job_id = getattr(app.state, "ytdlp_check_job", None)
    record = jobs.get(job_id) if job_id else None
    if record is not None and record.state in (JobState.pending, JobState.running):
        return record
    return None


def start_check(app, jobs: JobRegistry) -> JobRecord:
    """Submit the check job, or return the one already pending or running."""
    with _LOCK:
        record = _current_check(app, jobs)
        if record is not None:
            return record
        record = jobs.submit(
            JobKind.update_ytdlp, ytdlp_updates.check_and_install, pool="background"
        )
        app.state.ytdlp_check_job = record.id
        return record


def launch_check(app) -> None:
    """Start the daily check when it is due; never raises."""
    try:
        if ytdlp_updates.check_due():
            start_check(app, app.state.jobs)
    except Exception:  # noqa: BLE001 - an update check must never break startup
        _log.exception("could not start the yt-dlp update check")


def preference_changed(app, enabled: bool) -> None:
    """Called when the ``ytdlp_update`` preference is saved: turning it on runs the check
    that a launch with the option off skipped."""
    if enabled:
        launch_check(app)


@router.get("", response_model=YtdlpStatus)
def get_status(request: Request, jobs=Depends(get_jobs)) -> YtdlpStatus:
    current = _current_check(request.app, jobs)
    return YtdlpStatus(
        **ytdlp_updates.status(),
        check_job_id=current.id if current else None,
        check_state=current.state.value if current else None,
    )


@router.post("/check", response_model=JobRecord, status_code=202)
def check_now(request: Request, jobs=Depends(get_jobs)) -> JobRecord:
    if not load_preferences().ytdlp_update:
        raise HTTPException(
            status_code=409, detail="Turn on keeping the downloader up to date first."
        )
    return start_check(request.app, jobs)
