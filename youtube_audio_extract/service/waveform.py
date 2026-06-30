"""Server-side waveform peak computation for fast frontend rendering.

Decodes the audio once (via the shared ffmpeg PCM decode) and reduces it to per-bucket
min/max pairs so the frontend can draw a waveform without downloading and decoding the
whole file. Read-only; the result is cached to ``waveform.json`` by the route.
"""

from __future__ import annotations

import math
from pathlib import Path

from ..detection._pcm import SAMPLE_RATE, decode_pcm

WAVEFORM_VERSION = 1


def compute_peaks(
    path: str | Path,
    buckets: int = 2000,
    ffmpeg_bin: str = "ffmpeg",
) -> dict:
    """Return ``{version, sample_rate, buckets, duration_sec, min[], max[]}`` for ``path``.

    The signal is decoded to mono 16 kHz float32 and split into ``buckets`` equal frames;
    each frame contributes one min and one max sample. ``buckets`` is clamped down when
    the file has fewer samples than requested buckets.
    """
    import numpy as np

    pcm = decode_pcm(path, ffmpeg_bin)
    n = int(pcm.shape[0])
    duration = n / float(SAMPLE_RATE)

    if n == 0:
        return {
            "version": WAVEFORM_VERSION,
            "sample_rate": SAMPLE_RATE,
            "buckets": 0,
            "duration_sec": 0.0,
            "min": [],
            "max": [],
        }

    buckets = max(1, min(buckets, n))
    step = math.ceil(n / buckets)
    pad = step * buckets - n
    if pad > 0:
        pcm = np.concatenate([pcm, np.zeros(pad, dtype=pcm.dtype)])

    frames = pcm.reshape(buckets, step)
    mins = frames.min(axis=1)
    maxs = frames.max(axis=1)

    return {
        "version": WAVEFORM_VERSION,
        "sample_rate": SAMPLE_RATE,
        "buckets": buckets,
        "duration_sec": round(duration, 3),
        "min": [round(float(v), 5) for v in mins],
        "max": [round(float(v), 5) for v in maxs],
    }
