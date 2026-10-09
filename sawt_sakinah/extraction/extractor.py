"""Extract audio from a YouTube URL as an MP3 and describe it as an AudioSource.

Side-effecting layer: network + filesystem. It downloads, transcodes, probes, and
hands back an :class:`AudioSource`. It performs no analysis or editing.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
from pathlib import Path
from typing import Callable, Optional

import yt_dlp

from .. import runtime
from ..config import CONFIG
from ..models.sources import AudioSource
from ..models.errors import (
    AgeRestrictedError,
    ExtractionError,
    FileTooLargeError,
    LiveStreamError,
    PrivateVideoError,
    RegionLockedError,
    VideoUnavailableError,
)
from . import cache as _cache
from .finalize import emit as _emit
from .finalize import finalize_source
from .validate import normalize_url


_log = logging.getLogger(__name__)

#: Output stem for downloads. A fixed short name keeps paths under Windows' 260-character
#: limit however long the video title is; the title itself lives on the AudioSource.
DEFAULT_STEM = "source"

#: Shown when yt-dlp fails in a way none of the specific mappings recognise, which in
#: practice means YouTube changed something the bundled yt-dlp does not handle yet.
GENERIC_FAILURE = "YouTube may have changed. Check for an app update."

_NETWORK_HINTS = (
    "getaddrinfo",
    "urlopen error",
    "timed out",
    "name resolution",
    "network is unreachable",
    "connection refused",
    "connection reset",
    "remote end closed connection",
)


def _make_download_hook(callback: Callable[[dict], None]) -> Callable[[dict], None]:
    """Adapt yt-dlp's raw progress dict to a normalized ``{stage, percent, eta}``."""

    def hook(d: dict) -> None:
        total = d.get("total_bytes") or d.get("total_bytes_estimate")
        downloaded = d.get("downloaded_bytes")
        percent = (downloaded / total * 100.0) if total and downloaded else None
        _emit(
            callback,
            stage="download",
            status=d.get("status"),
            percent=percent,
            eta=d.get("eta"),
        )

    return hook


class _YtdlpLogger:
    """Routes yt-dlp's console output to :mod:`logging` (a windowed build has no console)."""

    def debug(self, msg: str) -> None:
        _log.debug("%s", msg)

    def info(self, msg: str) -> None:
        _log.debug("%s", msg)

    def warning(self, msg: str) -> None:
        _log.warning("%s", msg)

    def error(self, msg: str) -> None:
        _log.error("%s", msg)


def _map_download_error(err: Exception, url: str) -> ExtractionError:
    """Translate a yt-dlp DownloadError/ExtractorError into a typed ExtractionError.

    Recognised failures keep yt-dlp's message as the new error's text; network failures
    and unrecognised ones get a plain user-facing message. The original error is logged
    and chained.
    """
    msg = str(err)
    low = msg.lower()
    if "private video" in low:
        return PrivateVideoError(msg)
    if re.search(r"\bage\b|age[- ]restrict", low) and (
        "confirm" in low or "restrict" in low or "sign in" in low
    ):
        return AgeRestrictedError(msg)
    if "your country" in low or "region" in low or ("geo" in low and "block" in low):
        return RegionLockedError(msg)
    if "live event" in low or "is live" in low or "live stream" in low:
        return LiveStreamError(msg)
    if "unavailable" in low or "has been removed" in low or "been terminated" in low:
        return VideoUnavailableError(msg)
    _log.warning("yt-dlp failed for %s: %s", url, msg)
    if "not a bot" in low:
        return ExtractionError(
            "YouTube asked to confirm this is not a bot and refused the download. "
            "Try again later."
        )
    if any(hint in low for hint in _NETWORK_HINTS):
        return ExtractionError("Could not reach YouTube. Check your internet connection.")
    return ExtractionError(GENERIC_FAILURE)


def _js_runtimes() -> Optional[dict]:
    """yt-dlp ``js_runtimes`` pointing at the bundled (or, from source, PATH) Deno.

    Returns ``None`` to keep yt-dlp's default lookup in a source checkout without Deno,
    and an empty dict in the bundle so a missing copy never falls back to ``PATH``.
    """
    try:
        return {"deno": {"path": runtime.tool_path("deno")}}
    except runtime.ToolNotFoundError:
        if runtime.FROZEN:
            _log.warning("bundled Deno is missing; YouTube extraction may fail")
            return {}
        return None


def _expected_size(info: dict) -> Optional[int]:
    """Reported byte size of the selected format(s), or ``None`` when unknown."""
    total = 0
    for fmt in info.get("requested_formats") or [info]:
        size = fmt.get("filesize") or fmt.get("filesize_approx")
        if not size:
            return None
        total += int(size)
    return total


def _clock(seconds: float) -> str:
    """``h:mm:ss`` for a duration in seconds."""
    hours, rest = divmod(int(round(seconds)), 3600)
    return f"{hours}:{rest // 60:02d}:{rest % 60:02d}"


def _check_limits(info: dict, max_download_mb: int, max_duration_sec: float) -> None:
    """Reject live streams, over-long videos and oversized streams before downloading."""
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
        raise LiveStreamError("Live streams can't be imported. Try again after it ends.")
    duration = info.get("duration")
    if duration and duration > max_duration_sec:
        raise FileTooLargeError(
            f"This video is {_clock(duration)} long; the limit is {_clock(max_duration_sec)}."
        )
    size = _expected_size(info)
    if size and size > max_download_mb * 1024 * 1024:
        raise FileTooLargeError(
            f"This video's audio is about {size / (1024 * 1024):.0f} MB; the limit is "
            f"{max_download_mb} MB."
        )


def _source_id(source_url: str, audio_format: str, audio_quality: str) -> str:
    """Deterministic short id for an extraction request (for caching/reference)."""
    key = f"{source_url}|{audio_format}|{audio_quality}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def extract_audio(
    url: str,
    output_dir: str | os.PathLike = ".",
    filename: str | None = None,
    audio_format: str = CONFIG.extraction.audio_format,
    audio_quality: str = CONFIG.extraction.audio_quality,
    quiet: bool = CONFIG.extraction.quiet,
    progress_callback: Optional[Callable[[dict], None]] = None,
    create_working_copy: bool = CONFIG.extraction.create_working_copy,
    normalize_loudness: bool = CONFIG.extraction.normalize_loudness,
    use_cache: bool = CONFIG.extraction.use_cache,
    cache_dir: str | os.PathLike | None = None,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
    ffprobe_bin: str = CONFIG.ffmpeg.ffprobe_bin,
    max_download_mb: int = CONFIG.extraction.max_download_mb,
    max_duration_sec: float = CONFIG.extraction.max_duration_sec,
) -> AudioSource:
    """Download the best audio stream for ``url`` and return an :class:`AudioSource`.

    Goes straight from a YouTube link to an audio file -- no separate video download
    step -- then probes the result for authoritative metadata. The video's metadata is
    fetched first so live streams, over-long videos and oversized streams are rejected
    before anything is downloaded.

    Args:
        url: YouTube video URL or bare 11-char video id.
        output_dir: Directory to write the audio file into (created if missing).
        filename: Output filename without extension. Defaults to :data:`DEFAULT_STEM`;
            the video title is kept on the returned source, not in the path.
        audio_format: Target audio format passed to FFmpeg (default ``mp3``).
        audio_quality: FFmpeg audio quality. ``"0"`` is best VBR; or a bitrate
            like ``"192K"``.
        quiet: Suppress yt-dlp console output.
        progress_callback: Optional callable invoked during work with a normalized
            payload ``{stage, ...}`` where ``stage`` is one of ``"download"``,
            ``"probe"``, ``"normalize"``, ``"done"``. Framework-agnostic by design.
        create_working_copy: When true, also produce a 16 kHz mono WAV working copy
            and record it on ``AudioSource.working_copy`` for the detection layer.
        normalize_loudness: Apply EBU R128 ``loudnorm`` to the working copy (see
            :func:`make_working_copy`). Ignored when ``create_working_copy`` is false.
        use_cache: When true, return a prior :class:`AudioSource` for the same
            URL+format+quality without re-downloading, and persist new extractions.
        cache_dir: Cache root. Defaults to :func:`cache.default_cache_dir`.
        ffmpeg_bin: Name/path of the ffmpeg executable (also handed to yt-dlp).
        ffprobe_bin: Name/path of the ffprobe executable.
        max_download_mb: Reject audio streams larger than this many megabytes.
        max_duration_sec: Reject videos longer than this many seconds.

    Returns:
        An :class:`AudioSource` describing the extracted file.

    Raises:
        InvalidInputError: If ``url`` is not a single YouTube video.
        LiveStreamError: If ``url`` is a live or upcoming stream.
        FileTooLargeError: If the video exceeds ``max_duration_sec`` or its audio
            exceeds ``max_download_mb``.
        ExtractionError (or a subclass): If the video cannot be fetched.
        FileNotFoundError: If ffmpeg is missing or the expected output file is not
            produced.
    """
    source_url = normalize_url(url)
    source_id = _source_id(source_url, audio_format, audio_quality)
    resolved_cache_dir = Path(cache_dir) if cache_dir is not None else _cache.default_cache_dir()

    if use_cache:
        cached = _cache.load(resolved_cache_dir, source_id)
        if cached is not None:
            _emit(progress_callback, stage="cache", status="hit", percent=100.0)
            return cached

    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = filename if filename is not None else DEFAULT_STEM
    max_bytes = max_download_mb * 1024 * 1024

    ydl_opts = {
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / f"{stem}.%(ext)s"),
        "quiet": quiet,
        "no_warnings": quiet,
        "noprogress": quiet,
        "logger": _YtdlpLogger(),
        # A fixed stem can meet leftovers of an earlier attempt; never resume or reuse them.
        "overwrites": True,
        "continuedl": False,
        # yt-dlp derives ffprobe from the same folder.
        "ffmpeg_location": runtime.resolve_executable(ffmpeg_bin),
        "max_filesize": max_bytes,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": audio_format,
                "preferredquality": audio_quality,
            }
        ],
    }
    js_runtimes = _js_runtimes()
    if js_runtimes is not None:
        ydl_opts["js_runtimes"] = js_runtimes
    if progress_callback is not None:
        ydl_opts["progress_hooks"] = [_make_download_hook(progress_callback)]

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(source_url, download=False)
            _check_limits(info, max_download_mb, max_duration_sec)
            info = ydl.process_ie_result(info, download=True)
    except (yt_dlp.utils.DownloadError, yt_dlp.utils.ExtractorError) as err:
        raise _map_download_error(err, source_url) from err

    # After post-processing the file has the requested audio extension.
    result = out_dir / f"{stem}.{audio_format}"
    if not result.exists():
        # yt-dlp skips (without raising) a stream whose real size exceeds max_filesize.
        raise FileTooLargeError(
            f"This video's audio is larger than the {max_download_mb} MB limit."
        )

    # Probe + working copy + AudioSource + cache-save are shared with the upload
    # importer; only acquisition (the yt-dlp download above) is YouTube-specific.
    return finalize_source(
        result,
        source_id=source_id,
        title=info.get("title") or result.stem,
        source_kind="youtube",
        source_url=source_url,
        create_working_copy=create_working_copy,
        normalize_loudness=normalize_loudness,
        use_cache=use_cache,
        cache_dir=resolved_cache_dir,
        ffmpeg_bin=ffmpeg_bin,
        ffprobe_bin=ffprobe_bin,
        progress_callback=progress_callback,
    )
