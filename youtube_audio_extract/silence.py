"""Remove silent / relatively-silent segments from an audio file via FFmpeg."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path


def remove_silence(
    input_path: str | Path,
    output_path: str | Path | None = None,
    threshold_db: float = -40.0,
    min_silence_duration: float = 1.0,
    keep_silence: float = 0.0,
    ffmpeg_bin: str = "ffmpeg",
    overwrite: bool = True,
) -> Path:
    """Strip silence from ``input_path`` using FFmpeg's ``silenceremove`` filter.

    Removes every silent run in the file (leading, internal, and trailing) whose
    level stays below ``threshold_db`` for at least ``min_silence_duration``.

    Args:
        input_path: Source audio file.
        output_path: Destination file. Defaults to ``<input>.nosilence<ext>``.
        threshold_db: Loudness below this (in dB) counts as silence. Closer to 0
            (e.g. -30) is more aggressive; more negative (e.g. -50) is gentler.
        min_silence_duration: Minimum length in seconds of a quiet run before it
            is cut. Larger values keep short pauses; smaller values cut harder.
        keep_silence: Seconds of silence to leave in place at each cut, so speech
            does not butt together abruptly. 0 removes it entirely.
        ffmpeg_bin: Name/path of the ffmpeg executable.
        overwrite: Overwrite ``output_path`` if it already exists.

    Returns:
        Path to the de-silenced audio file.

    Raises:
        FileNotFoundError: If ffmpeg or the input file is missing.
        RuntimeError: If FFmpeg exits with an error.
    """
    src = Path(input_path)
    if not src.exists():
        raise FileNotFoundError(f"Input audio not found: {src}")
    if shutil.which(ffmpeg_bin) is None:
        raise FileNotFoundError(
            f"'{ffmpeg_bin}' not found on PATH. Install FFmpeg (standalone binary)."
        )

    dst = Path(output_path) if output_path is not None else src.with_name(
        f"{src.stem}.nosilence{src.suffix}"
    )

    # stop_periods=-1 removes all silent runs throughout the stream, not just one.
    silence_filter = (
        f"silenceremove="
        f"stop_periods=-1:"
        f"stop_duration={min_silence_duration}:"
        f"stop_threshold={threshold_db}dB:"
        f"stop_silence={keep_silence}"
    )

    cmd = [
        ffmpeg_bin,
        "-y" if overwrite else "-n",
        "-i", str(src),
        "-af", silence_filter,
        str(dst),
    ]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"FFmpeg silence removal failed (exit {proc.returncode}):\n{proc.stderr.strip()}"
        )
    return dst
