"""Per-region loudness measurement (read-only) for populating SilenceSegment.mean_db.

``silencedetect`` reports where silence is but not how loud each region is. This helper
runs a short, trimmed ``volumedetect`` pass over a single [start, end) span and returns
its mean level in dB. Analysis only -- never writes audio.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from ..config import CONFIG

_MEAN_VOL_RE = re.compile(r"mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB")


def measure_mean_db(
    input_path: str | Path,
    start: float,
    end: float,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
) -> float | None:
    """Return the mean loudness (dB) of ``input_path`` over ``[start, end)``.

    Uses ffmpeg's ``volumedetect`` over a trimmed span. Returns ``None`` when the span
    is empty/invalid or when volumedetect reports no finite mean (e.g. true digital
    silence prints ``-inf`` and no ``mean_volume`` line).

    Args:
        input_path: Source audio file.
        start: Region start in seconds.
        end: Region end in seconds.
        ffmpeg_bin: Name/path of the ffmpeg executable.
    """
    if end <= start:
        return None

    cmd = [
        ffmpeg_bin,
        "-ss", f"{start}",
        "-to", f"{end}",
        "-i", str(input_path),
        "-af", "volumedetect",
        "-f", "null",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        return None

    match = _MEAN_VOL_RE.search(proc.stderr)
    return float(match.group(1)) if match else None
