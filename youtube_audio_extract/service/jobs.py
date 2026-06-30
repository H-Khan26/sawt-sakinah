"""In-memory async job registry backed by thread pools.

Extraction (yt-dlp/ffmpeg subprocess) and detection (faster-whisper / onnxruntime
C-extensions) release the GIL during their heavy work, so threads -- not a process pool
-- give real concurrency while letting jobs share ``phrases.py``'s ``_MODEL_CACHE``
(a process pool would reload large-v3 per process). Phrase jobs run on a dedicated,
typically single-worker pool because concurrent Whisper on one device OOMs; quick
extraction/silence jobs run on the general pool so a long transcription never starves
them. State/progress is queried via :meth:`JobRegistry.get`, which returns a copy under
the lock. No Celery/Redis yet -- this is deliberately the simplest thing that gives
handles, state, and progress.
"""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from enum import Enum
from typing import Callable, Optional
from uuid import uuid4

from pydantic import BaseModel, Field

# A task body receives a progress callback and returns an optional JSON-able result dict.
TaskFn = Callable[[Callable[[dict], None]], Optional[dict]]


def _now() -> datetime:
    return datetime.now(timezone.utc)


class JobState(str, Enum):
    pending = "pending"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"


class JobRecord(BaseModel):
    """The observable state of a submitted job (returned by ``GET /jobs/{id}``)."""

    id: str
    kind: str
    project_id: Optional[str] = None
    state: JobState = JobState.pending
    progress: Optional[dict] = None
    result: Optional[dict] = None
    error: Optional[str] = None
    error_type: Optional[str] = None
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class JobRegistry:
    """Submit task bodies to thread pools and track their state/progress."""

    def __init__(self, max_workers: int = 4, phrase_workers: int = 1) -> None:
        self._jobs: dict[str, JobRecord] = {}
        self._lock = threading.Lock()
        self._pool = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="yae-job"
        )
        self._phrase_pool = ThreadPoolExecutor(
            max_workers=phrase_workers, thread_name_prefix="yae-phrase"
        )

    def submit(
        self,
        kind: str,
        fn: TaskFn,
        *,
        project_id: Optional[str] = None,
        pool: str = "default",
    ) -> JobRecord:
        """Register a job and schedule ``fn`` on the chosen pool; return its record."""
        job_id = uuid4().hex
        record = JobRecord(id=job_id, kind=kind, project_id=project_id)
        with self._lock:
            self._jobs[job_id] = record
        executor = self._phrase_pool if pool == "phrase" else self._pool
        executor.submit(self._run, job_id, fn)
        return record.model_copy(deep=True)

    def _run(self, job_id: str, fn: TaskFn) -> None:
        self._patch(job_id, state=JobState.running)
        try:
            result = fn(lambda payload: self.update_progress(job_id, payload))
            self._patch(job_id, state=JobState.succeeded, result=result or None)
        except Exception as exc:  # noqa: BLE001 - record any failure for the client
            self._patch(
                job_id,
                state=JobState.failed,
                error=str(exc),
                error_type=type(exc).__name__,
            )

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
        self._pool.shutdown(wait=False)
        self._phrase_pool.shutdown(wait=False)
