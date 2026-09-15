"""Shared ffmpeg PCM decode used by speech segmentation, phrase clip packing and waveform peaks.

Decodes any ffmpeg-readable file into an in-memory mono 16 kHz float32 numpy array.
Read-only: no file is written and the input is never mutated. ``numpy`` is imported
lazily so importing this module is cheap for callers that never decode.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from ..config import CONFIG

SAMPLE_RATE = CONFIG.audio.working_sample_rate


def decode_pcm(input_path: str | Path, ffmpeg_bin: str = CONFIG.ffmpeg.bin):
    """Decode ``input_path`` to a mono 16 kHz float32 numpy array via ffmpeg (in memory)."""
    import numpy as np

    cmd = [
        ffmpeg_bin,
        "-i", str(input_path),
        "-ac", "1",
        "-ar", str(SAMPLE_RATE),
        "-f", "s16le",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"FFmpeg PCM decode failed (exit {proc.returncode}):\n"
            f"{proc.stderr.decode('utf-8', 'replace').strip()}"
        )
    return np.frombuffer(proc.stdout, dtype="<i2").astype(np.float32) / 32768.0
