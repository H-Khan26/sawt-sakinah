"""Detect silent / relatively-silent regions as data (no audio mutation).

Two backends share one contract. The default, ``"vad"``, thresholds the source's Silero
speech-probability map (see ``segmentation.py`` / ``vad.py``) and reports the gaps
between speech spans, which separates quiet dhikr and room noise from real pauses. The
fallback, ``"ffmpeg"``, is FFmpeg's ``silencedetect`` energy gate: dependency-free, and
what the service uses when the ``vad`` extra is not installed. Both report timestamps
instead of cutting; this is the analysis counterpart to the editing layer's
``remove_silence``. See docs/audio/02-silence-detection.md.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING

from ..config import CONFIG
from ..ffmpeg import run_ffmpeg
from ..models import SilenceSegment
from ..proc import ffmpeg_input
from ._spans import merge_within_gap
from .loudness import measure_mean_db

if TYPE_CHECKING:  # pragma: no cover - typing only; segmentation needs numpy
    from .segmentation import SpeechMap

_START_RE = re.compile(r"silence_start:\s*(-?\d+(?:\.\d+)?)")
_END_RE = re.compile(r"silence_end:\s*(-?\d+(?:\.\d+)?)")


def detect_silence(
    input_path: str | Path,
    threshold_db: float = CONFIG.silence.threshold_db,
    min_silence_duration: float = CONFIG.silence.min_silence_duration,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
    *,
    merge_gap: float | None = CONFIG.silence.merge_gap,
    measure_loudness: bool = CONFIG.silence.measure_loudness,
    total_duration: float | None = None,
    detector: str = CONFIG.silence.detector,
    speech_threshold: float = CONFIG.segmentation.speech_threshold,
    min_speech_duration: float = CONFIG.segmentation.min_speech_duration,
    speech_map: "SpeechMap | None" = None,
    ffprobe_bin: str = CONFIG.ffmpeg.ffprobe_bin,
) -> list[SilenceSegment]:
    """Return the silent regions in ``input_path`` as structured segments.

    Pure analysis: reads the file and returns data. Does not modify or write audio.

    Args:
        input_path: Source audio file.
        threshold_db: Loudness below this (in dB) counts as silence. Closer to 0
            (e.g. -30) flags more as silent; more negative (e.g. -50) is stricter.
            ffmpeg detector only.
        min_silence_duration: Minimum length in seconds of a quiet run to report.
            Shorter pauses are ignored so natural gaps between words are preserved.
        ffmpeg_bin: Name/path of the ffmpeg executable.
        merge_gap: If set, adjacent silences separated by a gap no larger than this
            (seconds) are merged into one segment. ``None`` disables merging.
        measure_loudness: When true, populate each segment's ``mean_db`` with a short
            ``volumedetect`` pass over the region. Disable to skip the extra passes.
        total_duration: File duration in seconds, used to close a silence that runs to
            EOF. Probed via ffprobe when needed and not supplied (ffmpeg path).
        detector: Detection backend. ``"vad"`` (default) inverts the Silero speech
            map; ``"ffmpeg"`` runs the silencedetect energy gate.
        speech_threshold: Speech-probability threshold for the ``"vad"`` detector;
            ignored by the ffmpeg path.
        min_speech_duration: ``"vad"`` only: drop speech runs shorter than this before
            inverting, so brief blips do not split a silence.
        speech_map: ``"vad"`` only: the source's precomputed speech map. ``None``
            computes it in memory (requires the ``vad`` extra).
        ffprobe_bin: Name/path of the ffprobe executable, used to close a trailing
            silence when ``total_duration`` is not supplied (ffmpeg path).

    Returns:
        List of ``SilenceSegment`` ordered by start time.

    Raises:
        FileNotFoundError: If ffmpeg or the input file is missing.
        RuntimeError: If FFmpeg exits with an error or times out.
        ValueError: If an unsupported ``detector`` is requested.
        ImportError: If ``detector="vad"``, no ``speech_map`` is given, and
            onnxruntime is not installed.
    """
    if detector == "vad":
        from .vad import detect_silence_vad

        return detect_silence_vad(
            input_path,
            speech_map=speech_map,
            speech_threshold=speech_threshold,
            min_silence_duration=min_silence_duration,
            min_speech_duration=min_speech_duration,
            merge_gap=merge_gap,
            measure_loudness=measure_loudness,
            total_duration=total_duration,
            ffmpeg_bin=ffmpeg_bin,
        )
    if detector != "ffmpeg":
        raise ValueError(
            f"Unsupported detector {detector!r}; use 'vad' or 'ffmpeg'."
        )

    src = Path(input_path)
    if not src.exists():
        raise FileNotFoundError(f"Input audio not found: {src}")

    # silencedetect writes its findings to stderr; -f null discards the audio output.
    cmd = [
        ffmpeg_bin,
        *ffmpeg_input(src),
        "-af", f"silencedetect=noise={threshold_db}dB:d={min_silence_duration}",
        "-f", "null",
        "-",
    ]
    proc = run_ffmpeg(cmd)
    if proc.returncode != 0:
        raise RuntimeError(
            f"FFmpeg silence detection failed (exit {proc.returncode}):\n{proc.stderr.strip()}"
        )

    spans = _parse_silencedetect(proc.stderr)

    # Close a trailing silence that runs to EOF (silencedetect omits its end).
    if spans and spans[-1][1] is None:
        if total_duration is None:
            total_duration = _probe_duration(src, ffprobe_bin)
        start = spans[-1][0]
        spans[-1] = (start, total_duration) if total_duration > start else None
        if spans[-1] is None:
            spans.pop()

    if merge_gap is not None:
        spans = merge_within_gap(spans, merge_gap)

    segments: list[SilenceSegment] = []
    for start, end in spans:
        mean_db = measure_mean_db(src, start, end, ffmpeg_bin) if measure_loudness else None
        segments.append(SilenceSegment(start=start, end=end, mean_db=mean_db))
    return segments


def _parse_silencedetect(stderr: str) -> list[tuple[float, float | None]]:
    """Parse ffmpeg silencedetect stderr into ordered (start, end) spans.

    Pairs each ``silence_start`` with the following ``silence_end``. A trailing
    ``silence_start`` with no matching end (silence running to EOF) is kept with an
    ``end`` of ``None`` for the caller to close at the file duration.
    """
    spans: list[tuple[float, float | None]] = []
    pending_start: float | None = None

    for line in stderr.splitlines():
        start_match = _START_RE.search(line)
        if start_match:
            pending_start = float(start_match.group(1))
            continue
        end_match = _END_RE.search(line)
        if end_match and pending_start is not None:
            spans.append((pending_start, float(end_match.group(1))))
            pending_start = None

    if pending_start is not None:
        spans.append((pending_start, None))

    return spans


def _probe_duration(src: Path, ffprobe_bin: str) -> float:
    from ..extraction.probe import probe

    return probe(src, ffprobe_bin=ffprobe_bin)["duration_sec"]
