"""Prayer-structure contracts (domain interpretation of the marker stream).

A ``PrayerPosition`` is one labeled segment of a recitation (qiyam, ruku', i'tidal,
sujood, julus, tasleem ...), derived from the ordered ``Marker`` stream by the
``prayer/`` layer. Analysis/domain output only; never represents a mutation. See
docs/audio/00-overview.md and 05-data-model-and-api.md.

Times are always in seconds (float).
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field


class PrayerPosition(BaseModel):
    """One labeled prayer position within a rak'ah.

    Attributes:
        index: Ordinal of this position in the whole recitation (0-based).
        name: Position label -- qiyam | ruku | itidal | sujood | julus | tasleem.
        rakah: 1-based rak'ah number this position belongs to.
        start: Position start in seconds.
        end: Position end in seconds; ``None`` for the final, open-ended position.
        derived_from: ids of the ``Marker``s that produced this position boundary.
    """

    model_config = ConfigDict(frozen=True)

    index: int
    name: str
    rakah: int
    start: float
    end: Optional[float] = None
    derived_from: list[str] = Field(default_factory=list)

