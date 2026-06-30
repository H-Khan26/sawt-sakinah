"""Detected-region contracts (analysis output).

Times are always in seconds (float). See docs/audio/05-data-model-and-api.md.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, computed_field


class SilenceSegment(BaseModel):
    """A silent / relatively-silent region detected in an audio file.

    Produced by detection (analysis only); consumed by editing to drive cuts and by
    the frontend to highlight regions. Never represents a mutation itself.
    """

    model_config = ConfigDict(frozen=True)

    start: float          # seconds
    end: float            # seconds
    mean_db: Optional[float] = None  # average loudness, if known (for display/confidence)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def duration(self) -> float:
        return self.end - self.start

