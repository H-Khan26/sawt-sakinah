"""Extract audio from a YouTube URL as an MP3 using yt-dlp + FFmpeg."""

from __future__ import annotations

import os
from pathlib import Path

import yt_dlp


def extract_audio(
    url: str,
    output_dir: str | os.PathLike = ".",
    filename: str | None = None,
    audio_format: str = "mp3",
    audio_quality: str = "0",
    quiet: bool = True,
) -> Path:
    """Download the best audio stream for ``url`` and convert it to MP3.

    Goes straight from a YouTube link to an audio file -- no separate video
    download step.

    Args:
        url: YouTube video URL.
        output_dir: Directory to write the audio file into (created if missing).
        filename: Output filename without extension. Defaults to the video title.
        audio_format: Target audio format passed to FFmpeg (default ``mp3``).
        audio_quality: FFmpeg audio quality. ``"0"`` is best VBR; or a bitrate
            like ``"192K"``.
        quiet: Suppress yt-dlp console output.

    Returns:
        Path to the extracted audio file.

    Raises:
        yt_dlp.utils.DownloadError: If the video cannot be fetched.
        FileNotFoundError: If the expected output file is not produced.
    """
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

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)

    # After post-processing the file has the requested audio extension.
    base = ydl.prepare_filename(info)
    result = Path(base).with_suffix(f".{audio_format}")
    if not result.exists():
        raise FileNotFoundError(f"Expected extracted audio at {result}, but it was not found.")
    return result
