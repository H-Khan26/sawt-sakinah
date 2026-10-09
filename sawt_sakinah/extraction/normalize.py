"""Produce a normalized PCM working copy (16 kHz mono WAV) for detection.

Detection thresholds and the Silero speech-segmentation pass behave consistently when
fed a standardized signal regardless of the source's sample rate / channels / level.
This write lives in the extraction (side-effecting) layer so detection stays read-only.
"""

from __future__ import annotations

from pathlib import Path

from ..config import CONFIG
from ..ffmpeg import run_ffmpeg
from ..proc import ffmpeg_input

# Sample rate that both energy thresholds and Silero/WebRTC VAD expect.
WORKING_SAMPLE_RATE = CONFIG.audio.working_sample_rate

# Suffix appended to the source stem for the working copy. The speech-map sidecar strips
# it to share the source's stem, so the two must agree on the one literal.
WORKING_SUFFIX = ".work.wav"


def make_working_copy(
    input_path: str | Path,
    output_path: str | Path | None = None,
    normalize_loudness: bool = CONFIG.extraction.normalize_loudness,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
    overwrite: bool = True,
) -> Path:
    """Write a 16 kHz mono PCM WAV copy of ``input_path`` and return its path.

    Args:
        input_path: Source audio file (e.g. the extracted mp3).
        output_path: Destination WAV. Defaults to ``<input>.work.wav``.
        normalize_loudness: When true, apply EBU R128 ``loudnorm`` so a fixed
            ``threshold_db`` is comparable across recordings of differing levels.
            Off by default because it shifts absolute dB values, which would require
            re-tuning the silence threshold.
        ffmpeg_bin: Name/path of the ffmpeg executable.
        overwrite: Overwrite ``output_path`` if it already exists.

    Returns:
        Path to the working-copy WAV.

    Raises:
        FileNotFoundError: If ffmpeg or the input file is missing.
        RuntimeError: If FFmpeg exits with an error or times out.
    """
    src = Path(input_path)
    if not src.exists():
        raise FileNotFoundError(f"Input audio not found: {src}")

    dst =Path(output_path) if output_path is not None else src.with_name(
        f"{src.stem}{WORKING_SUFFIX}"
    )

    cmd = [ffmpeg_bin, "-y" if overwrite else "-n", *ffmpeg_input(src)]
    if normalize_loudness:
        cmd += ["-af", "loudnorm=I=-23:TP=-2:LRA=11"]
    cmd += [
        "-ac", "1",
        "-ar", str(WORKING_SAMPLE_RATE),
        "-c:a", "pcm_s16le",
        "-vn",
        str(dst),
    ]

    proc = run_ffmpeg(cmd)
    if proc.returncode != 0:
        raise RuntimeError(
            f"FFmpeg normalization failed (exit {proc.returncode}):\n{proc.stderr.strip()}"
        )
    return dst
