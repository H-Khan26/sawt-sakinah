"""Surah-map contracts (analysis output).

A ``SurahPassage`` records one continuous stretch of recitation recognised as a run of
ayat of one surah, on the source timeline. Produced by ``detection/surahs.py`` (analysis
only) from the transcript; consumed by the editor to tint and select surahs and by export
to write chapters. Never represents a mutation itself.

Times are always in seconds (float). See docs/audio/03-surah-recognition.md and
docs/audio/05-data-model-and-api.md.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

#: ``accept``: confidently recognised; ``unsure``: matched, but not strongly enough to be
#: certain of the surah, so the user listens before acting on it.
PassageLevel = Literal["accept", "unsure"]


def _now() -> datetime:
    return datetime.now(timezone.utc)


class SurahPassage(BaseModel):
    """A recited passage: one surah, a range of its ayat, and where it sits in the audio.

    Attributes:
        surah: Surah number (1..114).
        ayah_from: First ayah heard (1-based, inclusive).
        ayah_to: Last ayah heard (inclusive).
        start: Passage start in seconds, padded into the pause before it.
        end: Passage end in seconds, padded into the pause after it.
        confidence: Matched transcript words over the words the passage spans (0..1).
        level: ``"accept"`` or ``"unsure"``.
    """

    model_config = ConfigDict(frozen=True)

    surah: int = Field(ge=1, le=114)
    ayah_from: int = Field(ge=1)
    ayah_to: int = Field(ge=1)
    start: float
    end: float
    confidence: float
    level: PassageLevel


class SurahMap(BaseModel):
    """The result of one surah-matching run over a recording.

    Attributes:
        model: Catalog id of the Whisper model the transcript came from.
        matched_at: When the matching ran (UTC).
        passages: Accepted and unsure passages, ordered by ``start``.
    """

    model_config = ConfigDict(frozen=True)

    model: str
    matched_at: datetime = Field(default_factory=_now)
    passages: list[SurahPassage] = Field(default_factory=list)
