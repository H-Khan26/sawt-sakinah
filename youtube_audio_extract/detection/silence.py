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

from ..config import CONFIG
from ..models import SilenceSegment
from .loudness import measure_mean_db

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
    speech_threshold: float = CONFIG.silence.speech_threshold,
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
        merge_gap: If set, adjacent silences separated by a gap no larger than this
            (seconds) are merged into one segment. ``None`` disables merging.
        measure_loudness: When true, populate each segment's ``mean_db`` with a short
            ``volumedetect`` pass over the region. Disable to skip the extra passes.
        total_duration: File duration in seconds, used to close a silence that runs to
            EOF. Probed via ffprobe when needed and not supplied.
        detector: Detection backend. ``"ffmpeg"`` (silencedetect energy gate, default)
            or ``"vad"`` (Silero voice-activity detection; requires the optional 'vad'
            extra). The VAD path better separates quiet dhikr / noise from recitation.
        speech_threshold: Speech-probability threshold for the ``"vad"`` detector;
            ignored by the ffmpeg path.

    Returns:
        List of ``SilenceSegment`` ordered by start time.

    Raises:
        FileNotFoundError: If ffmpeg or the input file is missing.
        RuntimeError: If FFmpeg exits with an error.
        ValueError: If an unsupported ``detector`` is requested.
        ImportError: If ``detector="vad"`` and the optional VAD deps are missing.
    """
    if detector == "vad":
        from .vad import detect_silence_vad

        return detect_silence_vad(
            input_path,
            speech_threshold=speech_threshold,
            min_silence_duration=min_silence_duration,
            merge_gap=merge_gap,
            measure_loudness=measure_loudness,
            ffmpeg_bin=ffmpeg_bin,
        )
    if detector != "ffmpeg":
        raise ValueError(
            f"Unsupported detector {detector!r}; use 'ffmpeg' or 'vad'."
        )

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

    spans = _parse_silencedetect(proc.stderr)

    # Close a trailing silence that runs to EOF (silencedetect omits its end).
    if spans and spans[-1][1] is None:
        if total_duration is None:
            total_duration = _probe_duration(src, ffmpeg_bin)
        start = spans[-1][0]
        spans[-1] = (start, total_duration) if total_duration > start else None
        if spans[-1] is None:
            spans.pop()

    if merge_gap is not None:
        spans = _merge_within_gap(spans, merge_gap)

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


def _merge_within_gap(
    spans: list[tuple[float, float]], merge_gap: float
) -> list[tuple[float, float]]:
    """Merge adjacent spans separated by a gap no larger than ``merge_gap``."""
    if not spans:
        return spans
    merged: list[tuple[float, float]] = [spans[0]]
    for start, end in spans[1:]:
        prev_start, prev_end = merged[-1]
        if start - prev_end <= merge_gap:
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def _probe_duration(src: Path, ffmpeg_bin: str) -> float:
    from ..extraction.probe import ffprobe_for, probe

    return probe(src, ffprobe_bin=ffprobe_for(ffmpeg_bin))["duration_sec"]
