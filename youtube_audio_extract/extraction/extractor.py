"""Extract audio from a YouTube URL as an MP3 and describe it as an AudioSource.

Side-effecting layer: network + filesystem. It downloads, transcodes, probes, and
hands back an :class:`AudioSource`. It performs no analysis or editing.
"""

from __future__ import annotations

import hashlib
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

import yt_dlp

from ..models.sources import AudioSource
from ..models.errors import (
    AgeRestrictedError,
    ExtractionError,
    LiveStreamError,
    PrivateVideoError,
    RegionLockedError,
    VideoUnavailableError,
)
from .hashing import content_hash
from .normalize import make_working_copy
from .probe import probe
from .validate import normalize_url


def _map_download_error(err: Exception, url: str) -> ExtractionError:
    """Translate a yt-dlp DownloadError into a typed ExtractionError.

    The original message is preserved as the new error's text and via chaining.
    """
    msg = str(err)
    low = msg.lower()
    if "private video" in low:
        return PrivateVideoError(msg)
    if "age" in low and ("confirm" in low or "restrict" in low or "sign in" in low):
        return AgeRestrictedError(msg)
    if "your country" in low or "region" in low or "geo" in low and "block" in low:
        return RegionLockedError(msg)
    if "live event" in low or "is live" in low or "live stream" in low:
        return LiveStreamError(msg)
    if "unavailable" in low or "has been removed" in low or "been terminated" in low:
        return VideoUnavailableError(msg)
    return ExtractionError(msg)


def _source_id(source_url: str, audio_format: str, audio_quality: str) -> str:
    """Deterministic short id for an extraction request (for caching/reference)."""
    key = f"{source_url}|{audio_format}|{audio_quality}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def extract_audio(
    url: str,
    output_dir: str | os.PathLike = ".",
    filename: str | None = None,
    audio_format: str = "mp3",
    audio_quality: str = "0",
    quiet: bool = True,
    progress_callback: Optional[Callable[[dict], None]] = None,
    create_working_copy: bool = True,
    normalize_loudness: bool = False,
) -> AudioSource:
    """Download the best audio stream for ``url`` and return an :class:`AudioSource`.

    Goes straight from a YouTube link to an audio file -- no separate video download
    step -- then probes the result for authoritative metadata.

    Args:
        url: YouTube video URL or bare 11-char video id.
        output_dir: Directory to write the audio file into (created if missing).
        filename: Output filename without extension. Defaults to the video title.
        audio_format: Target audio format passed to FFmpeg (default ``mp3``).
        audio_quality: FFmpeg audio quality. ``"0"`` is best VBR; or a bitrate
            like ``"192K"``.
        quiet: Suppress yt-dlp console output.
        progress_callback: Optional callable invoked with yt-dlp's raw progress dict
            during download. Kept framework-agnostic; the normalized payload shape is
            defined in a later phase.
        create_working_copy: When true, also produce a 16 kHz mono WAV working copy
            and record it on ``AudioSource.working_copy`` for the detection layer.
        normalize_loudness: Apply EBU R128 ``loudnorm`` to the working copy (see
            :func:`make_working_copy`). Ignored when ``create_working_copy`` is false.

    Returns:
        An :class:`AudioSource` describing the extracted file.

    Raises:
        InvalidInputError: If ``url`` is not a single YouTube video.
        ExtractionError (or a subclass): If the video cannot be fetched.
        FileNotFoundError: If the expected output file is not produced.
    """
    source_url = normalize_url(url)

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # %(title)s is replaced by yt-dlp; use a fixed stem if a filename is given.
    stem = filename if filename is not None else "%(title)s"
    outtmpl = str(out_dir / f"{stem}.%(ext)s")

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": outtmpl,
        "quiet": quiet,
        "no_warnings": quiet,
        "noprogress": quiet,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": audio_format,
                "preferredquality": audio_quality,
            }
        ],
    }
    if progress_callback is not None:
        ydl_opts["progress_hooks"] = [progress_callback]

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(source_url, download=True)
            base = ydl.prepare_filename(info)
    except yt_dlp.utils.DownloadError as err:
        raise _map_download_error(err, source_url) from err

    # After post-processing the file has the requested audio extension.
    result = Path(base).with_suffix(f".{audio_format}")
    if not result.exists():
        raise FileNotFoundError(
            f"Expected extracted audio at {result}, but it was not found."
        )

    meta = probe(result)
    working_copy = (
        make_working_copy(result, normalize_loudness=normalize_loudness)
        if create_working_copy
        else None
    )
    return AudioSource(
        source_url=source_url,
        local_path=result,
        title=info.get("title") or result.stem,
        duration_sec=meta["duration_sec"],
        sample_rate=meta["sample_rate"],
        channels=meta["channels"],
        codec=meta["codec"],
        content_hash=content_hash(result),
        id=_source_id(source_url, audio_format, audio_quality),
        extracted_at=datetime.now(timezone.utc),
        working_copy=working_copy,
    )
