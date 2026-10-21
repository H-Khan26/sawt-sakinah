"""Pure span arithmetic shared by the detection modules (no I/O, no models).

A span is a half-open-ish ``(start, end)`` pair in seconds. Both silence detection and
transcription need the same handful of operations on ordered span lists -- merging spans
that sit close together, inverting a speech list into its gaps, padding and clamping -- so
they live here rather than in either consumer, keeping ``vad.py`` and ``transcribe.py``
from importing each other.
"""

from __future__ import annotations

from bisect import bisect_right
from typing import Optional, Sequence

Span = tuple[float, float]


class SpeechIndex:
    """Speech and silence seconds in any interval, from sorted non-overlapping speech
    spans. Without spans every interval counts as silence."""

    def __init__(self, spans: Optional[Sequence[Span]]) -> None:
        self.spans: list[Span] = list(spans) if spans else []
        self.starts = [a for a, _ in self.spans]
        self.ends = [b for _, b in self.spans]
        self.cum = [0.0]
        for a, b in self.spans:
            self.cum.append(self.cum[-1] + (b - a))

    def _upto(self, t: float) -> float:
        k = bisect_right(self.starts, t)
        if k == 0:
            return 0.0
        return self.cum[k - 1] + min(t, self.ends[k - 1]) - self.starts[k - 1]

    def speech(self, a: float, b: float) -> float:
        """Speech seconds in ``[a, b]``."""
        return self._upto(b) - self._upto(a) if b > a else 0.0

    def silence(self, a: float, b: float) -> float:
        """Non-speech seconds in ``[a, b]``."""
        return (b - a) - self.speech(a, b) if b > a else 0.0

    def lead_in(self, t: float) -> float:
        """Seconds of speech from the start of the span holding ``t`` up to ``t``; 0 when
        ``t`` falls in a pause."""
        k = bisect_right(self.starts, t) - 1
        return t - self.starts[k] if k >= 0 and t <= self.ends[k] else 0.0


def merge_within_gap(spans: list[Span], merge_gap: float) -> list[Span]:
    """Merge adjacent spans separated by a gap no larger than ``merge_gap``.

    ``spans`` must be ordered by start. Overlapping spans (negative gap) always merge,
    so this doubles as a normalizer after padding.
    """
    if not spans:
        return spans
    merged: list[Span] = [spans[0]]
    for start, end in spans[1:]:
        prev_start, prev_end = merged[-1]
        if start - prev_end <= merge_gap:
            merged[-1] = (prev_start, max(prev_end, end))
        else:
            merged.append((start, end))
    return merged


def invert_spans(spans: list[Span], total: float) -> list[Span]:
    """Return the gaps between ``spans`` over ``[0, total]`` (no minimum-length filter).

    Zero-length gaps are dropped; callers apply their own duration thresholds.
    """
    gaps: list[Span] = []
    prev_end = 0.0
    for start, end in spans:
        if start > prev_end:
            gaps.append((prev_end, start))
        prev_end = max(prev_end, end)
    if total > prev_end:
        gaps.append((prev_end, total))
    return gaps


def pad_spans(spans: list[Span], pad: float, total: float | None = None) -> list[Span]:
    """Widen each span by ``pad`` seconds on both sides and clamp to ``[0, total]``.

    ``total`` may be ``None`` when the file duration is unknown, in which case only the
    lower bound is clamped. Padding can make neighbours overlap; run the result through
    :func:`merge_within_gap` to normalize.
    """
    out: list[Span] = []
    for start, end in spans:
        a = max(0.0, start - pad)
        b = end + pad if total is None else min(total, end + pad)
        if b > a:
            out.append((a, b))
    return out
