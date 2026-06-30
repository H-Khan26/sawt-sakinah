"""Detect silent / relatively-silent regions as data (no audio mutation).

Baseline implementation uses FFmpeg's ``silencedetect`` filter, which reports
timestamps to stderr instead of cutting. This is the analysis counterpart to the
editing layer's ``remove_silence``. See docs/audio/02-silence-detection.md for the
candidate upgrades (librosa energy, VAD) an implementing agent may evaluate.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

from ..models import SilenceSegment

_START_RE = re.compile(r"silence_start:\s*(-?\d+(?:\.\d+)?)")
_END_RE = re.compile(r"silence_end:\s*(-?\d+(?:\.\d+)?)")


def detect_silence(
    input_path: str | Path,
    threshold_db: float = -40.0,
    min_silence_duration: float = 1.0,
    ffmpeg_bin: str = "ffmpeg",
) -> list[SilenceSegment]:
    """Return the silent regions in ``input_path`` as structured segments.

    Pure analysis: reads the file and returns data. Does not modify or write audio.

    Args:
        input_path: Source audio file.
        threshold_db: Loudness below this (in dB) counts as silence. Closer to 0
            (e.g. -30) flags more as silent; more negative (e.g. -50) is stricter.
        min_silence_duration: Minimum length in seconds of a quiet run to report.
            Shorter pauses are ignored so natural gaps between words are preserved.
        ffmpeg_bin: Name/path of the ffmpeg executable.

    Returns:
        List of ``SilenceSegment`` ordered by start time.

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

    # silencedetect writes its findings to stderr; -f null discards the audio output.
    cmd = [
        ffmpeg_bin,
        "-i", str(src),
        "-af", f"silencedetect=noise={threshold_db}dB:d={min_silence_duration}",
        "-f", "null",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"FFmpeg silence detection failed (exit {proc.returncode}):\n{proc.stderr.strip()}"
        )

    return _parse_silencedetect(proc.stderr)


def _parse_silencedetect(stderr: str) -> list[SilenceSegment]:
    """Parse ffmpeg silencedetect stderr into ordered SilenceSegments.

    Pairs each ``silence_start`` with the following ``silence_end``. A trailing
    ``silence_start`` with no matching end (silence running to EOF) is dropped, since
    silencedetect does not always emit a closing end for it.
    """
    segments: list[SilenceSegment] = []
    pending_start: float | None = None

    for line in stderr.splitlines():
        start_match = _START_RE.search(line)
        if start_match:
            pending_start = float(start_match.group(1))
            continue
        end_match = _END_RE.search(line)
        if end_match and pending_start is not None:
            segments.append(SilenceSegment(start=pending_start, end=float(end_match.group(1))))
            pending_start = None

    return segments
