"""Audio streaming (ranged) and lazily-cached waveform peaks."""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from ...fileio import replace_file
from ..deps import get_settings, get_store
from ..playback import PLAYBACK_MEDIA_TYPE, ensure_playback_copy
from ..ranges import media_type_for, ranged_file_response
from ..waveform import WAVEFORM_VERSION, compute_peaks
from .common import validate_id

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/projects", tags=["media"])


@router.get("/{project_id}/audio")
def get_audio(
    project_id: str,
    request: Request,
    container: Optional[Literal["mp4"]] = None,
    store=Depends(get_store),
    settings=Depends(get_settings),
):
    """Stream the user-facing artifact (the mp3), honoring Range requests for seeking.

    ``container=mp4`` serves the same MP3 frames remuxed into MP4 (see ``playback``), which
    the browser seeks exactly. If that copy can't be made it answers 503 rather than the
    mp3, so one URL never serves byte ranges of two different files; the editor then
    falls back to the plain URL.

    Resolves the path via ``store.audio_path`` -- a cheap single-field read -- rather than
    a full ``load`` + ``_heal``, since scrubbing issues many range requests per second.
    """
    validate_id(project_id, "project_id")
    local = store.audio_path(project_id)
    if local is None:
        raise HTTPException(status_code=404, detail="recording not found")
    if not local.exists():
        raise HTTPException(status_code=404, detail="audio not found")

    path, media_type = local, media_type_for(local)
    if container == "mp4" and local.suffix.lower() == ".mp3":
        try:
            path = ensure_playback_copy(
                local, store.playback_path(project_id), ffmpeg_bin=settings.ffmpeg_bin
            )
            media_type = PLAYBACK_MEDIA_TYPE
        except (OSError, RuntimeError) as exc:
            _log.warning("no playback copy for %s: %s", project_id, exc)
            raise HTTPException(status_code=503, detail="playback copy unavailable") from exc
    return ranged_file_response(
        path,
        request.headers.get("range"),
        media_type,
        streams=store.streams,
        key=project_id,
    )


@router.get("/{project_id}/waveform")
def get_waveform(project_id: str, store=Depends(get_store), settings=Depends(get_settings)):
    validate_id(project_id, "project_id")

    # Waveform is immutable per source: serve the cache before touching the project.
    # A cache from an older format version is recomputed and replaced.
    cache = store.waveform_path(project_id)
    if cache.exists():
        try:
            cached = json.loads(cache.read_text(encoding="utf-8"))
            if isinstance(cached, dict) and cached.get("version") == WAVEFORM_VERSION:
                return cached
        except (ValueError, OSError):
            pass  # corrupt cache -> recompute

    local = store.audio_path(project_id)
    if local is None:
        raise HTTPException(status_code=404, detail="recording not found")

    peaks = compute_peaks(local, ffmpeg_bin=settings.ffmpeg_bin)
    _cache_peaks(cache, peaks)
    return peaks


def _cache_peaks(cache: Path, peaks: dict) -> None:
    """Write the peaks cache atomically; best-effort — never raise on failure.

    Uses a unique temp file so concurrent first-time requests don't collide on one name,
    and retries the rename to ride out transient Windows locks (WinError 32) from a virus
    scanner touching the freshly-written file. If caching ultimately fails the caller still
    returns the computed peaks — the cache is only an optimization.
    """
    tmp_name: str | None = None
    try:
        fd, tmp_name = tempfile.mkstemp(dir=str(cache.parent), suffix=".json.tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(peaks, fh)
        replace_file(tmp_name, cache)
        tmp_name = None  # renamed away; nothing to clean up
    except OSError:
        pass  # leave the cache absent; peaks are recomputed next time
    finally:
        if tmp_name and os.path.exists(tmp_name):
            try:
                os.remove(tmp_name)
            except OSError:
                pass
