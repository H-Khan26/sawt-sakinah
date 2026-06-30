"""Job status polling."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from ..deps import get_jobs
from ..jobs import JobRecord

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.get("/{job_id}", response_model=JobRecord)
def get_job(job_id: str, jobs=Depends(get_jobs)) -> JobRecord:
    record = jobs.get(job_id)
    if record is None:
        raise HTTPException(status_code=404, detail="job not found")
    return record
