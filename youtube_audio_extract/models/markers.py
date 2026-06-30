"""Phrase-marker contract (analysis output).

A ``Marker`` records where a recognised spoken phrase (takbir, tasmi', tahmid,
tasleem, ...) occurs in an audio file. Produced by ``detection/phrases.py`` (analysis
only); consumed by the prayer state machine to label positions and by the frontend to
render navigable points on the waveform. Never represents a mutation itself.

Times are always in seconds (float). See docs/audio/03-phrase-detection.md and
docs/audio/05-data-model-and-api.md.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict, field
from typing import Optional


@dataclass(frozen=True)
class Marker:
    """A detected spoken phrase, anchored to a timestamp.

    Attributes:
        time: Onset of the phrase, in seconds.
        label: Human-readable label, e.g. "Allahu Akbar".
        type: Phrase category -- "takbir" | "tasmi" | "tahmid" | "tasleem" | "custom".
        confidence: Detection confidence in [0, 1].
        end: Optional offset of the phrase, in seconds.
        source: "auto" for detector output, "user" for hand-placed markers.
        id: Stable identifier; derived from type + time when left blank.
    """

    time: float
    label: str
    type: str
    confidence: float
    end: Optional[float] = None
    source: str = "auto"
    id: str = field(default="")

    def __post_init__(self) -> None:
        if not self.id:
            object.__setattr__(self, "id", f"{self.type}-{self.time:.3f}")

    @property
    def duration(self) -> Optional[float]:
        return None if self.end is None else self.end - self.time

    def to_dict(self) -> dict:
        d = asdict(self)
        d["duration"] = self.duration
        return d

    @classmethod
    def from_dict(cls, data: dict) -> "Marker":
        return cls(
            time=data["time"],
            label=data["label"],
            type=data["type"],
            confidence=data["confidence"],
            end=data.get("end"),
            source=data.get("source", "auto"),
            id=data.get("id", ""),
        )
