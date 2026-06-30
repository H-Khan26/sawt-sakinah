"""Edit Decision List contracts (non-destructive editing).

An ``EditDecisionList`` is the record of edits the user/UI makes against an
``AudioSource``. It is never applied as the user clicks; the editing layer renders it
to a new audio file only on export. This enables undo/redo and re-editing while keeping
the original intact. See docs/audio/04-editing-and-export.md.

Times are always in seconds (float).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


def _now() -> datetime:
    return datetime.now(timezone.utc)


class EditOperation(BaseModel):
    """A single non-destructive edit against the source timeline.

    Attributes:
        type: ``"cut"`` removes ``[start, end]``; ``"keep"`` retains only the listed
            keep spans (and drops the rest); ``"fade"`` applies a short fade at a
            boundary; ``"marker"`` is a metadata point (not a mutation) that export may
            embed as a chapter/cue.
        start: Span/point start in seconds.
        end: Span end in seconds. ``None`` for a point (``marker``) or a single-edge fade.
    """

    model_config = ConfigDict(frozen=True)

    type: Literal["cut", "keep", "fade", "marker"]
    start: float
    end: Optional[float] = None


class EditDecisionList(BaseModel):
    """An ordered list of edit operations against a single ``AudioSource``.

    ``source_id`` ties the EDL to the ``AudioSource.id`` it was authored against, so an
    export can reject an EDL that does not belong to the project's source.
    """

    model_config = ConfigDict(frozen=True)

    source_id: str
    operations: list[EditOperation] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)

