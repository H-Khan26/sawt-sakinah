"""Shared post-acquisition step: turn a produced audio file into an ``AudioSource``.

Both acquisition front-ends converge here. Once a decodable audio file exists on disk --
whether yt-dlp downloaded and transcoded it (:mod:`extractor`) or the importer transcoded
a user upload (:mod:`importer`) -- this module probes it, optionally builds the detection
working copy and its speech-map sidecar, assembles the :class:`AudioSource`, and persists
it to the cache. Keeping the tail in one place means the two front-ends share identical
metadata, working-copy, and cache semantics and never drift apart.

Side-effecting (filesystem): probes, may write a working copy and a speech map, may write
a cache sidecar.
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
from .probe import probe
from .segment import write_speech_map


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
    create_speech_map: bool = CONFIG.extraction.create_speech_map,
    normalize_loudness: bool = CONFIG.extraction.normalize_loudness,
    use_cache: bool = CONFIG.extraction.use_cache,
    cache_dir: str | os.PathLike | None = None,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
    ffprobe_bin: str = CONFIG.ffmpeg.ffprobe_bin,
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
        create_speech_map: Also compute the Silero speech-probability sidecar from the
            working copy (requires it, and the ``vad`` extra; skipped with a
            ``"segment"``/``"skipped"`` progress event when onnxruntime is missing).
        normalize_loudness: Apply EBU R128 loudnorm to the working copy.
        use_cache: Persist the resulting source as a cache sidecar.
        cache_dir: Cache root (resolved to the default when ``None``).
        ffmpeg_bin: Name/path of the ffmpeg executable.
        ffprobe_bin: Name/path of the ffprobe executable.
        progress_callback: Normalized ``{stage, ...}`` progress sink; stages are
            ``"probe"``, ``"normalize"``, ``"segment"``, ``"done"``.

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
    meta = probe(result, ffprobe_bin=ffprobe_bin)

    working_copy = None
    if create_working_copy:
        emit(progress_callback, stage="normalize", status="start")
        working_copy = make_working_copy(
            result, normalize_loudness=normalize_loudness, ffmpeg_bin=ffmpeg_bin
        )

    # The speech map derives from the working copy, so it is only attempted once that
    # exists. A missing onnxruntime is not an extraction failure: the detectors fall
    # back (energy gate / full-file Whisper) and the field stays None.
    speech_map = None
    if working_copy is not None and create_speech_map:
        emit(progress_callback, stage="segment", status="start")
        try:
            speech_map = write_speech_map(working_copy, ffmpeg_bin=ffmpeg_bin)
        except ImportError as err:
            emit(progress_callback, stage="segment", status="skipped", reason=str(err))

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
        speech_map=speech_map,
    )

    if use_cache:
        resolved = Path(cache_dir) if cache_dir is not None else _cache.default_cache_dir()
        _cache.save(resolved, source)

    emit(progress_callback, stage="done", status="finished", percent=100.0)
    return source
