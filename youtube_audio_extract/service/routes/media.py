"""Audio streaming (ranged) and lazily-cached waveform peaks."""

from __future__ import annotations

import json
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request

from ..deps import get_settings, get_store
from ..ranges import media_type_for, ranged_file_response
from ..waveform import compute_peaks
from .common import validate_id

router = APIRouter(prefix="/projects", tags=["media"])


@router.get("/{project_id}/audio")
def get_audio(project_id: str, request: Request, store=Depends(get_store)):
    """Stream the user-facing artifact (the mp3), honoring Range requests for seeking."""
    validate_id(project_id, "project_id")
    project = store.load(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    local = Path(project.audio_source.local_path)
    if not local.exists():
        raise HTTPException(status_code=404, detail="audio not found")
    return ranged_file_response(
        local, request.headers.get("range"), media_type_for(local)
    )


@router.get("/{project_id}/waveform")
def get_waveform(project_id: str, store=Depends(get_store), settings=Depends(get_settings)):
    validate_id(project_id, "project_id")
    project = store.load(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")

    cache = store.waveform_path(project_id)
    if cache.exists():
        try:
            return json.loads(cache.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            pass  # corrupt cache -> recompute

    peaks = compute_peaks(
        project.audio_source.local_path, ffmpeg_bin=settings.ffmpeg_bin
    )
    tmp = cache.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(peaks), encoding="utf-8")
    os.replace(tmp, cache)
    return peaks
