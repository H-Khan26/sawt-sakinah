"""Speech-aware silence detection: invert a :class:`SpeechMap` into ``SilenceSegment``s.

The energy gate in ``silence.py`` cannot tell quiet dhikr or room noise from a pause; the
speech map (Silero probabilities, see ``segmentation.py``) can. This module is a thin
consumer of that map: it derives fine speech spans with the segmentation knobs, inverts
them to gaps over the file, keeps only gaps at least ``min_silence_duration`` long (the
user-facing report threshold, applied after inversion so it never leaks into Silero's
own bridging), optionally merges near-adjacent silences, and measures loudness.

Callers normally hand in the persisted map so re-thresholding costs milliseconds. When
none is given the map is computed in memory, which needs the ``vad`` extra
(onnxruntime). Read-only: no file is written and the input is never mutated.
"""

from __future__ import annotations

from pathlib import Path

from ..config import CONFIG
from ..models import SilenceSegment
from ._spans import invert_spans, merge_within_gap
from .loudness import measure_mean_db
from .segmentation import SpeechMap


def detect_silence_vad(
    input_path: str | Path,
    *,
    speech_map: SpeechMap | None = None,
    speech_threshold: float = CONFIG.segmentation.speech_threshold,
    min_silence_duration: float = CONFIG.silence.min_silence_duration,
    min_speech_duration: float = CONFIG.segmentation.min_speech_duration,
    merge_gap: float | None = CONFIG.silence.merge_gap,
    measure_loudness: bool = CONFIG.silence.measure_loudness,
    total_duration: float | None = None,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
) -> list[SilenceSegment]:
    """Report the non-speech regions of ``input_path`` as ``SilenceSegment``s.

    Args:
        input_path: Source audio file (any format ffmpeg can decode). Used for the
            in-memory map computation when ``speech_map`` is absent and for loudness.
        speech_map: Precomputed Silero probabilities for this file. ``None`` computes
            them now (requires the ``vad`` extra).
        speech_threshold: Speech-probability threshold (0..1); higher is stricter
            about what counts as speech, yielding more/longer silences.
        min_silence_duration: Minimum gap length in seconds to report as silence.
        min_speech_duration: Drop speech runs shorter than this (seconds) before
            inverting, so brief blips do not split a silence.
        merge_gap: Merge adjacent silences separated by a gap no larger than this.
        measure_loudness: Populate each segment's ``mean_db`` via volumedetect.
        total_duration: File duration used to close a trailing silence. Defaults to
            the map's covered duration (whole frames, so up to 32 ms long).
        ffmpeg_bin: Name/path of the ffmpeg executable.

    Raises:
        FileNotFoundError: If the input file is missing.
        ImportError: If the map must be computed and onnxruntime is not installed.
        RuntimeError: If ffmpeg fails to decode the input.
    """
    src = Path(input_path)
    if not src.exists():
        raise FileNotFoundError(f"Input audio not found: {src}")

    if speech_map is None:
        speech_map = SpeechMap.compute(src, ffmpeg_bin)
    total = total_duration if total_duration is not None else speech_map.duration

    spans = speech_map.spans(
        threshold=speech_threshold, min_speech_duration=min_speech_duration
    )
    silences = [
        gap for gap in invert_spans(spans, total) if gap[1] - gap[0] >= min_silence_duration
    ]
    if merge_gap is not None:
        silences = merge_within_gap(silences, merge_gap)

    segments: list[SilenceSegment] = []
    for start, end in silences:
        mean_db = measure_mean_db(src, start, end, ffmpeg_bin) if measure_loudness else None
        segments.append(SilenceSegment(start=start, end=end, mean_db=mean_db))
    return segments
