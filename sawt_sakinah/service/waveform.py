"""Server-side waveform levels computation for fast frontend rendering.

Decodes the audio once (via the shared ffmpeg PCM decode) and reduces it to per-bucket
RMS levels at a fixed time resolution, so the frontend can draw a waveform without
downloading and decoding the whole file. RMS (not sample peaks) because limited
recordings pin their peaks at full scale, which hides the difference between speech
and silence. Read-only; the result is cached to ``waveform.json`` by the route.
"""

from __future__ import annotations

import base64
import math
from pathlib import Path

from ..config import CONFIG
from ..detection._pcm import SAMPLE_RATE, decode_pcm

WAVEFORM_VERSION = 2

# RMS percentile that maps to full height: the recording's loudest passages, so a single
# click or burst doesn't flatten everything else.
SCALE_PERCENTILE = 99.5

# Scale floor for (near-)silent files, so the division and the dB label stay finite.
MIN_SCALE = 1e-4


def compute_peaks(
    path: str | Path,
    rate: int = CONFIG.service.waveform_rate,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
) -> dict:
    """Return ``{version, sample_rate, rate, buckets, duration_sec, scale_db, levels}``.

    The signal is decoded to mono 16 kHz float32 and split into consecutive frames of
    ``SAMPLE_RATE / rate`` samples (the last one may be shorter). Each frame's RMS is
    divided by the recording's ``SCALE_PERCENTILE`` RMS, clipped to ``[0, 1]`` and
    quantized to one byte; ``levels`` is those bytes base64-encoded. ``scale_db`` is the
    level of full height in dBFS RMS. ``rate`` in the result is the exact buckets per
    second after rounding the frame length to whole samples.
    """
    import numpy as np

    pcm = decode_pcm(path, ffmpeg_bin)
    n = int(pcm.shape[0])
    step = max(1, round(SAMPLE_RATE / rate))
    result = {
        "version": WAVEFORM_VERSION,
        "sample_rate": SAMPLE_RATE,
        "rate": SAMPLE_RATE / step,
        "buckets": 0,
        "duration_sec": round(n / float(SAMPLE_RATE), 3),
        "scale_db": round(20 * math.log10(MIN_SCALE), 1),
        "levels": "",
    }
    if n == 0:
        return result

    full = n // step
    frames = pcm[: full * step].reshape(full, step)
    # einsum sums the squares without materializing a squared copy of the whole signal.
    sums = np.einsum("ij,ij->i", frames, frames, dtype=np.float64)
    rms = np.sqrt(sums / step)
    # A tail shorter than half a bucket is dropped rather than drawn as a full-width bucket,
    # unless it is the whole file.
    tail = pcm[full * step :]
    if tail.size * 2 >= step or full == 0:
        rms = np.append(rms, math.sqrt(float(np.dot(tail, tail)) / tail.size))

    scale = max(float(np.percentile(rms, SCALE_PERCENTILE)), MIN_SCALE)
    levels = np.round(np.clip(rms / scale, 0.0, 1.0) * 255).astype(np.uint8)

    result["buckets"] = int(levels.size)
    result["scale_db"] = round(20 * math.log10(scale), 1)
    result["levels"] = base64.b64encode(levels.tobytes()).decode("ascii")
    return result
