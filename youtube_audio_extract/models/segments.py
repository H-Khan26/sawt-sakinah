"""Detected-region contracts (analysis output).

Times are always in seconds (float). See docs/audio/05-data-model-and-api.md.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Optional


@dataclass(frozen=True)
class SilenceSegment:
    """A silent / relatively-silent region detected in an audio file.

    Produced by detection (analysis only); consumed by editing to drive cuts and by
    the frontend to highlight regions. Never represents a mutation itself.
    """

    start: float          # seconds
    end: float            # seconds
    mean_db: Optional[float] = None  # average loudness, if known (for display/confidence)

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_dict(self) -> dict:
        d = asdict(self)
        d["duration"] = self.duration
        return d
