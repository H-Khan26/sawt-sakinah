"""In-memory async job registry backed by thread pools.

Extraction (yt-dlp/ffmpeg subprocess) and detection (faster-whisper / onnxruntime
C-extensions) release the GIL during their heavy work, so threads -- not a process pool
-- give real concurrency while letting jobs share ``phrases.py``'s ``_MODEL_CACHE``
(a process pool would reload large-v3 per process). Phrase jobs run on a dedicated,
typically single-worker pool because concurrent Whisper on one device OOMs; quick
extraction/silence jobs run on the general pool so a long transcription never starves
them. State/progress is queried via :meth:`JobRegistry.get`, which returns a copy under
the lock. At most ``service.max_pending_jobs`` jobs may be pending or running at once;
further submissions raise :class:`JobQueueFullError`. No Celery/Redis yet -- this is
deliberately the simplest thing that gives handles, state, and progress.
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from enum import Enum
from typing import Callable, Optional
from uuid import uuid4

from pydantic import BaseModel, Field

from ..config import CONFIG

_log = logging.getLogger(__name__)

# A task body receives a progress callback and returns an optional JSON-able result dict.
TaskFn = Callable[[Callable[[dict], None]], Optional[dict]]


def _now() -> datetime:
    return datetime.now(timezone.utc)


class JobQueueFullError(RuntimeError):
    """Too many jobs are already pending or running; the caller should retry later."""


class JobState(str, Enum):
    pending = "pending"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"


class JobKind(str, Enum):
    extract = "extract"
    detect_silence = "detect_silence"
    detect_phrases = "detect_phrases"
    export = "export"
    split = "split"
    download_model = "download_model"


class JobRecord(BaseModel):
    """The observable state of a submitted job (returned by ``GET /jobs/{id}``)."""

    id: str
    kind: JobKind
    project_id: Optional[str] = None
    state: JobState = JobState.pending
    progress: Optional[dict] = None
    result: Optional[dict] = None
    error: Optional[str] = None
    error_type: Optional[str] = None
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


def _failure(error: str, exc: BaseException) -> dict:
    """The ``_patch`` fields recording a failed job."""
    return {"state": JobState.failed, "error": error, "error_type": type(exc).__name__}


# Final state of a job dropped from the queue at shutdown.
_CANCELLED = {
    "state": JobState.failed,
    "error": "The job was cancelled at shutdown.",
    "error_type": "JobCancelledError",
}


class JobRegistry:
    """Submit task bodies to thread pools and track their state/progress."""

    def __init__(
        self,
        max_workers: int = CONFIG.service.max_workers,
        phrase_workers: int = CONFIG.service.phrase_workers,
        max_pending_jobs: int = CONFIG.service.max_pending_jobs,
    ) -> None:
        self._jobs: dict[str, JobRecord] = {}
        self._max_pending = max_pending_jobs
        self._active = 0  # jobs submitted and not yet finished
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="sawt-job"
        )
        self._phrase_pool = ThreadPoolExecutor(
            max_workers=phrase_workers, thread_name_prefix="sawt-phrase"
        )

    def ensure_capacity(self) -> None:
        """Raise :class:`JobQueueFullError` now if a submission would be refused.

        Lets a route fail before doing expensive setup (e.g. staging an upload); ``submit``
        still enforces the limit itself.
        """
        with self._lock:
            if self._active >= self._max_pending:
                raise self._full_error()

    def _full_error(self) -> JobQueueFullError:
        return JobQueueFullError(
            f"{self._active} jobs are already queued or running. "
            "Wait for some to finish and try again."
        )

    def submit(
        self,
        kind: JobKind,
        fn: TaskFn,
        *,
        project_id: Optional[str] = None,
        pool: str = "default",
        on_finish: Optional[Callable[[], None]] = None,
    ) -> JobRecord:
        """Register a job and schedule ``fn`` on the chosen pool; return its record.

        ``on_finish`` runs once the job ends in any way: succeeded, failed, or dropped from
        the queue at shutdown. It runs before the final state is recorded, so a client that
        sees the job finished also sees its effects undone. It does not run when ``submit``
        raises, and it must be safe to call more than once.

        Raises:
            JobQueueFullError: If ``max_pending_jobs`` jobs are already pending or running.
        """
        job_id = uuid4().hex
        record = JobRecord(id=job_id, kind=kind, project_id=project_id)
        with self._lock:
            if self._active >= self._max_pending:
                raise self._full_error()
            self._active += 1
            self._jobs[job_id] = record
        executor = self._phrase_pool if pool == "phrase" else self._pool
        try:
            future = executor.submit(self._run, job_id, fn, on_finish)
        except BaseException:
            with self._lock:
                self._active -= 1
                self._jobs.pop(job_id, None)
            raise
        # A job cancelled before it started (dropped at shutdown) never reaches ``_run``.
        future.add_done_callback(
            lambda f: self._close(job_id, _CANCELLED, on_finish) if f.cancelled() else None
        )
        return record.model_copy(deep=True)

    def _run(
        self, job_id: str, fn: TaskFn, on_finish: Optional[Callable[[], None]] = None
    ) -> None:
        try:
            self._patch(job_id, state=JobState.running)
            result = fn(lambda payload: self.update_progress(job_id, payload))
            outcome = {"state": JobState.succeeded, "result": result or None}
        except BaseException as exc:  # noqa: BLE001 - the job's Future is never read
            if isinstance(exc, Exception):
                outcome = _failure(str(exc), exc)
            else:  # SystemExit, KeyboardInterrupt and the like
                _log.exception("job %s stopped with %s", job_id, type(exc).__name__)
                outcome = _failure(repr(exc), exc)
        self._close(job_id, outcome, on_finish)

    def _close(
        self, job_id: str, outcome: dict, on_finish: Optional[Callable[[], None]]
    ) -> None:
        """Run ``on_finish``, record the job's final state and stop counting it as active."""
        try:
            if on_finish is not None:
                try:
                    on_finish()
                except BaseException:  # noqa: BLE001 - nothing else would report it
                    _log.exception("on_finish failed for job %s", job_id)
            self._patch(job_id, **outcome)
        finally:
            with self._lock:
                self._active -= 1

    def update_progress(self, job_id: str, payload: dict) -> None:
        self._patch(job_id, progress=payload)

    def get(self, job_id: str) -> Optional[JobRecord]:
        with self._lock:
            record = self._jobs.get(job_id)
            return record.model_copy(deep=True) if record is not None else None

    def _patch(self, job_id: str, **fields) -> None:
        with self._lock:
            record = self._jobs.get(job_id)
            if record is None:
                return
            for key, value in fields.items():
                setattr(record, key, value)
            record.updated_at = _now()

    def shutdown(self) -> None:
        """Drop queued jobs (recorded as failed) and return without waiting for running ones.

        The interpreter still joins the worker threads at exit, so without
        ``cancel_futures`` every queued job would run first.
        """
        self._pool.shutdown(wait=False, cancel_futures=True)
        self._phrase_pool.shutdown(wait=False, cancel_futures=True)
