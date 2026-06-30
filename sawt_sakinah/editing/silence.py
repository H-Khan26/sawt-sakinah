"""Remove silent / relatively-silent segments from an audio file via FFmpeg."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Sequence

from ..config import CONFIG
from ..models import EditOperation, SilenceSegment
from .render import _render


def remove_silence(
    input_path: str | Path,
    output_path: str | Path | None = None,
    threshold_db: float = CONFIG.silence.threshold_db,
    min_silence_duration: float = CONFIG.silence.min_silence_duration,
    keep_silence: float = CONFIG.silence.keep_silence,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
    overwrite: bool = True,
    segments: Sequence[SilenceSegment] | None = None,
) -> Path:
    """Strip silence from ``input_path`` and write a new file.

    Two modes:

    * **Threshold (default)** -- FFmpeg's ``silenceremove`` filter removes every silent
      run (leading, internal, trailing) below ``threshold_db`` for at least
      ``min_silence_duration``.
    * **Explicit segments** -- when ``segments`` is given (e.g. the output of
      :func:`detect_silence`, possibly filtered by the user/UI), exactly those time
      spans are cut and the rest is kept. ``threshold_db`` / ``min_silence_duration`` /
      ``keep_silence`` are ignored in this mode. This is how detection output drives an
      edit non-destructively.

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
        segments: Explicit silence spans to cut. When provided, switches to
            explicit-segment mode (see above).

    Returns:
        Path to the de-silenced audio file.

    Raises:
        FileNotFoundError: If ffmpeg or the input file is missing.
        ValueError: If ``segments`` cover the entire file (nothing left to keep).
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

    if segments is not None:
        # Explicit-segment mode now delegates to the general renderer: each silence span
        # becomes a ``cut`` op. ``boundary_fade=0`` and no metadata refresh preserve the
        # original byte-for-byte behavior of this path.
        operations = [
            EditOperation(type="cut", start=s.start, end=s.end) for s in segments
        ]
        return _render(
            src,
            0.0,  # 0 -> the engine probes the source for its authoritative duration.
            operations,
            dst,
            ffmpeg_bin=ffmpeg_bin,
            overwrite=overwrite,
            boundary_fade=0.0,
            embed_markers=False,
            metadata=None,
        )

    # stop_periods=-1 removes all silent runs throughout the stream, not just one.
    silence_filter = (
        f"silenceremove="
        f"stop_periods=-1:"
        f"stop_duration={min_silence_duration}:"
        f"stop_threshold={threshold_db}dB:"
        f"stop_silence={keep_silence}"
    )
    cmd = [ffmpeg_bin, "-y" if overwrite else "-n", "-i", str(src), "-af", silence_filter, str(dst)]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"FFmpeg silence removal failed (exit {proc.returncode}):\n{proc.stderr.strip()}"
        )
    return dst
