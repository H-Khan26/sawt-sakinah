"""Phrase-marker contract (analysis output).

A ``Marker`` records where a recognised spoken phrase (takbir, tasmi', tahmid,
tasleem, ...) occurs in an audio file. Produced by ``detection/phrases.py`` (analysis
only); consumed by the prayer state machine to label positions and by the frontend to
render navigable points on the waveform. Never represents a mutation itself.

Times are always in seconds (float). See docs/audio/03-phrase-detection.md and
docs/audio/05-data-model-and-api.md.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, computed_field, model_validator


class Marker(BaseModel):
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

    model_config = ConfigDict(frozen=True)

    time: float
    label: str
    type: str
    confidence: float
    end: Optional[float] = None
    source: str = "auto"
    id: str = ""

    @model_validator(mode="after")
    def _derive_id(self) -> "Marker":
        if not self.id:
            # Model is frozen; assign through __dict__ as pydantic does internally.
            object.__setattr__(self, "id", f"{self.type}-{self.time:.3f}")
        return self

    @computed_field  # type: ignore[prop-decorator]
    @property
    def duration(self) -> Optional[float]:
        return None if self.end is None else self.end - self.time

    def to_dict(self) -> dict:
        return self.model_dump(mode="json")

    @classmethod
    def from_dict(cls, data: dict) -> "Marker":
        return cls.model_validate(data)
