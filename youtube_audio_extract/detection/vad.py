"""Voice-activity-based silence detection (Silero VAD via onnxruntime).

This is the "recitation vs not-recitation" upgrade over the energy-gate baseline: it
classifies speech vs non-speech per frame and reports the non-speech spans as
``SilenceSegment``s, so it separates quiet dhikr / room noise from actual recitation.

Boundary: like all of ``detection/`` this is read-only. Audio is decoded into memory
via ffmpeg (16 kHz mono PCM) -- no file is written and the input is never mutated.

The model dependencies (``onnxruntime`` + ``silero-vad``) are optional; install them
with the project's ``vad`` extra (see requirements-vad.txt). They are imported lazily
so the baseline ffmpeg path never needs them.
"""

from __future__ import annotations

from pathlib import Path

from ..config import CONFIG
from ..models import SilenceSegment
from ._pcm import SAMPLE_RATE as _SAMPLE_RATE, decode_pcm as _decode_pcm
from .loudness import measure_mean_db


def _invert_to_silences(
    speech: list[tuple[float, float]], total: float, min_silence_duration: float
) -> list[tuple[float, float]]:
    """Return the gaps between speech spans (the silences) over ``[0, total]``."""
    silences: list[tuple[float, float]] = []
    prev_end = 0.0
    for start, end in speech:
        if start - prev_end >= min_silence_duration:
            silences.append((prev_end, start))
        prev_end = max(prev_end, end)
    if total - prev_end >= min_silence_duration:
        silences.append((prev_end, total))
    return silences


def detect_silence_vad(
    input_path: str | Path,
    *,
    speech_threshold: float = CONFIG.silence.speech_threshold,
    min_silence_duration: float = CONFIG.silence.min_silence_duration,
    min_speech_duration: float = CONFIG.silence.min_speech_duration,
    merge_gap: float | None = CONFIG.silence.merge_gap,
    measure_loudness: bool = CONFIG.silence.measure_loudness,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
) -> list[SilenceSegment]:
    """Detect non-speech (silence) regions using Silero VAD.

    Args:
        input_path: Source audio file (any format ffmpeg can decode).
        speech_threshold: Speech-probability threshold (0..1); higher is stricter
            about what counts as speech, yielding more/longer silences.
        min_silence_duration: Minimum gap length in seconds to report as silence.
        min_speech_duration: Drop speech runs shorter than this (seconds) before
            inverting, so brief blips do not split a silence.
        merge_gap: Merge adjacent silences separated by a gap no larger than this.
        measure_loudness: Populate each segment's ``mean_db`` via volumedetect.
        ffmpeg_bin: Name/path of the ffmpeg executable.

    Raises:
        ImportError: If the optional VAD dependencies are not installed.
        RuntimeError: If ffmpeg fails to decode the input.
    """
    try:
        from silero_vad import get_speech_timestamps, load_silero_vad
    except ImportError as err:  # pragma: no cover - exercised only without the extra
        raise ImportError(
            "VAD detection requires the optional 'vad' extra "
            "(pip install -r requirements-vad.txt: onnxruntime + silero-vad)."
        ) from err

    src = Path(input_path)
    if not src.exists():
        raise FileNotFoundError(f"Input audio not found: {src}")

    audio = _decode_pcm(src, ffmpeg_bin)
    total = len(audio) / _SAMPLE_RATE

    model = load_silero_vad(onnx=True)
    speech_ts = get_speech_timestamps(
        audio,
        model,
        sampling_rate=_SAMPLE_RATE,
        threshold=speech_threshold,
        min_speech_duration_ms=int(min_speech_duration * 1000),
        min_silence_duration_ms=int(min_silence_duration * 1000),
        return_seconds=True,
    )
    speech = [(float(t["start"]), float(t["end"])) for t in speech_ts]

    silences = _invert_to_silences(speech, total, min_silence_duration)

    if merge_gap is not None:
        from .silence import _merge_spans

        silences = _merge_spans(silences, merge_gap)

    segments: list[SilenceSegment] = []
    for start, end in silences:
        mean_db = measure_mean_db(src, start, end, ffmpeg_bin) if measure_loudness else None
        segments.append(SilenceSegment(start=start, end=end, mean_db=mean_db))
    return segments
