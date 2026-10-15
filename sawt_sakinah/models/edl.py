"""Edit Decision List contracts (non-destructive editing).

An ``EditDecisionList`` is the record of edits the user/UI makes against an
``AudioSource``. It is never applied as the user clicks; the editing layer renders it
to a new audio file only on export. This enables undo/redo and re-editing while keeping
the original intact. See docs/audio/04-editing-and-export.md.

Times are always in seconds (float).
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional, Sequence

from pydantic import BaseModel, ConfigDict, Field


# Cut spans closer than this (seconds) count as touching and merge into one.
_TOUCH = 1e-6


def _now() -> datetime:
    return datetime.now(timezone.utc)


class EditOperation(BaseModel):
    """A single non-destructive edit against the source timeline.

    Attributes:
        type: ``"cut"`` removes ``[start, end]``; ``"keep"`` retains only the listed
            keep spans (and drops the rest); ``"fade"`` applies a short fade at a
            boundary.
        start: Span start in seconds.
        end: Span end in seconds. ``None`` for a single-edge fade or an open-ended cut.
    """

    model_config = ConfigDict(frozen=True)

    type: Literal["cut", "keep", "fade"]
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


def normalize_cuts(
    operations: Sequence[EditOperation], duration: Optional[float] = None
) -> list[EditOperation]:
    """Return ``operations`` with the ``cut`` spans sorted, merged and clamped.

    A cut given end-first is read as the same span. Overlapping or touching cuts merge,
    so the removed audio is a set of disjoint spans; with a known ``duration`` each is
    clamped to ``[0, duration]`` and empty ones drop. The other ops (and any open-ended
    cut) follow the cuts in their original order.
    """
    hi = duration if duration and duration > 0 else float("inf")
    ordered = (
        sorted((op.start, op.end))
        for op in operations
        if op.type == "cut" and op.end is not None
    )
    spans = sorted((max(0.0, a), min(hi, b)) for a, b in ordered)
    merged: list[tuple[float, float]] = []
    for a, b in spans:
        if b <= a:
            continue
        if merged and a <= merged[-1][1] + _TOUCH:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    cuts = [EditOperation(type="cut", start=a, end=b) for a, b in merged]
    rest = [op for op in operations if not (op.type == "cut" and op.end is not None)]
    return cuts + rest
