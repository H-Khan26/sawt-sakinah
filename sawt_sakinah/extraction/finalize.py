"""Shared post-acquisition step: turn a produced audio file into an ``AudioSource``.

Both acquisition front-ends converge here. Once a decodable audio file exists on disk --
whether yt-dlp downloaded and transcoded it (:mod:`extractor`) or the importer transcoded
a user upload (:mod:`importer`) -- this module probes it, optionally builds the detection
working copy, assembles the :class:`AudioSource`, and persists it to the cache. Keeping the
tail in one place means the two front-ends share identical metadata, working-copy, and
cache semantics and never drift apart.

Side-effecting (filesystem): probes, may write a working copy, may write a cache sidecar.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from ..config import CONFIG
from ..models.sources import AudioSource, SourceKind
from . import cache as _cache
from .hashing import content_hash
from .normalize import make_working_copy
from .probe import ffprobe_for, probe


def emit(callback: Optional[Callable[[dict], None]], **payload) -> None:
    """Invoke a progress callback with a normalized payload, if one was supplied."""
    if callback is not None:
        callback(payload)


def finalize_source(
    result_path: str | os.PathLike,
    *,
    source_id: str,
    title: str,
    source_kind: SourceKind,
    source_url: Optional[str] = None,
    original_filename: Optional[str] = None,
    create_working_copy: bool = CONFIG.extraction.create_working_copy,
    normalize_loudness: bool = CONFIG.extraction.normalize_loudness,
    use_cache: bool = CONFIG.extraction.use_cache,
    cache_dir: str | os.PathLike | None = None,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
    progress_callback: Optional[Callable[[dict], None]] = None,
) -> AudioSource:
    """Probe ``result_path``, build its working copy, and return a cached ``AudioSource``.

    Args:
        result_path: The produced user-facing audio artifact (the transcoded mp3).
        source_id: Deterministic short id (acquisition key + format + quality).
        title: Display title (video title, or the uploaded file's stem).
        source_kind: Provenance discriminator (``"youtube"`` or ``"upload"``).
        source_url: Canonical URL for downloads; ``None`` for uploads.
        original_filename: The uploaded file's name; ``None`` for downloads.
        create_working_copy: Also emit the 16 kHz mono WAV detection feeds on.
        normalize_loudness: Apply EBU R128 loudnorm to the working copy.
        use_cache: Persist the resulting source as a cache sidecar.
        cache_dir: Cache root (resolved to the default when ``None``).
        ffmpeg_bin: ffmpeg executable; the matching ffprobe is derived from it.
        progress_callback: Normalized ``{stage, ...}`` progress sink; stages are
            ``"probe"``, ``"normalize"``, ``"done"``.

    Raises:
        FileNotFoundError: If ``result_path`` (or ffmpeg/ffprobe) is missing.
        RuntimeError: If ffprobe finds no audio stream or ffmpeg fails.
    """
    result = Path(result_path)
    if not result.exists():
        raise FileNotFoundError(
            f"Expected produced audio at {result}, but it was not found."
        )

    emit(progress_callback, stage="probe", status="start")
    meta = probe(result, ffprobe_bin=ffprobe_for(ffmpeg_bin))

    working_copy = None
    if create_working_copy:
        emit(progress_callback, stage="normalize", status="start")
        working_copy = make_working_copy(
            result, normalize_loudness=normalize_loudness, ffmpeg_bin=ffmpeg_bin
        )

    source = AudioSource(
        local_path=result,
        title=title,
        duration_sec=meta["duration_sec"],
        sample_rate=meta["sample_rate"],
        channels=meta["channels"],
        codec=meta["codec"],
        content_hash=content_hash(result),
        id=source_id,
        created_at=datetime.now(timezone.utc),
        source_kind=source_kind,
        source_url=source_url,
        original_filename=original_filename,
        working_copy=working_copy,
    )

    if use_cache:
        resolved = Path(cache_dir) if cache_dir is not None else _cache.default_cache_dir()
        _cache.save(resolved, source)

    emit(progress_callback, stage="done", status="finished", percent=100.0)
    return source
