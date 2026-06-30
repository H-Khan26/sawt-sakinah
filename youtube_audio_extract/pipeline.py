"""End-to-end: YouTube URL -> extracted MP3 -> silence removed."""

from __future__ import annotations

import os
from pathlib import Path

from .extraction import extract_audio
from .editing import remove_silence


def youtube_to_clean_audio(
    url: str,
    output_dir: str | os.PathLike = ".",
    filename: str | None = None,
    audio_format: str = "mp3",
    audio_quality: str = "0",
    threshold_db: float = -40.0,
    min_silence_duration: float = 1.0,
    keep_silence: float = 0.0,
    keep_intermediate: bool = False,
    quiet: bool = True,
) -> Path:
    """Extract audio from ``url`` and remove silent segments in one call.

    Args:
        url: YouTube video URL.
        output_dir: Directory for output files.
        filename: Output stem (no extension). Defaults to the video title.
        audio_format: Audio codec/extension for extraction (default ``mp3``).
        audio_quality: FFmpeg audio quality (``"0"`` = best VBR, or e.g. ``"192K"``).
        threshold_db: Silence loudness threshold in dB (see ``remove_silence``).
        min_silence_duration: Minimum silent-run length in seconds to cut.
        keep_silence: Seconds of silence to leave at each cut.
        keep_intermediate: Keep the raw extracted file alongside the cleaned one.
        quiet: Suppress yt-dlp output.

    Returns:
        Path to the cleaned (silence-removed) audio file.
    """
    source = extract_audio(
        url,
        output_dir=output_dir,
        filename=filename,
        audio_format=audio_format,
        audio_quality=audio_quality,
        quiet=quiet,
    )
    raw = source.local_path

    cleaned = raw.with_name(f"{raw.stem}.nosilence{raw.suffix}")
    remove_silence(
        raw,
        output_path=cleaned,
        threshold_db=threshold_db,
        min_silence_duration=min_silence_duration,
        keep_silence=keep_silence,
    )

    if not keep_intermediate:
        raw.unlink(missing_ok=True)

    return cleaned
