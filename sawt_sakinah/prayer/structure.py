"""Derive prayer structure (ordered ``PrayerPosition``s) from the marker stream.

Domain layer: takes the analysis output (``Marker``s) and interprets it as the
positions of a salah. Never reads or writes audio. A prayer cycles through a fixed
sequence of positions per rak'ah, and each transition between positions is announced by
a spoken phrase -- the takbir ("Allahu Akbar"), or the tasmi' ("Sami' Allahu liman
hamidah") when rising from ruku' to i'tidal. The closing tasleem ends the prayer.
See docs/audio/00-overview.md.

The mapping is intentionally minimal: each *advancing* marker (takbir / tasmi') closes
the position that is currently open and opens the next one in the cycle; ``N`` advancing
markers therefore yield ``N + 1`` positions. tahmid markers sit *within* i'tidal and do
not advance; the tasleem marker closes the prayer with a final ``tasleem`` position.
Times are always in seconds (float).
"""

from __future__ import annotations

from typing import Optional, Sequence

from ..models import Marker, PrayerPosition

# Canonical within-rak'ah position cycle. After the last entry the next advancing marker
# starts a new rak'ah back at ``qiyam``.
_POSITION_CYCLE = ("qiyam", "ruku", "itidal", "sujood", "julus", "sujood")

# Marker types that move the recitation from one position to the next.
_ADVANCING = frozenset({"takbir", "tasmi"})


def _position(
    index: int,
    name: str,
    rakah: int,
    start: float,
    end: Optional[float],
    opened_by: Optional[str],
    closed_by: Optional[str],
) -> PrayerPosition:
    derived = [mid for mid in (opened_by, closed_by) if mid]
    return PrayerPosition(
        index=index,
        name=name,
        rakah=rakah,
        start=start,
        end=end,
        derived_from=derived,
    )


def derive_structure(
    markers: Sequence[Marker],
    total_duration: Optional[float] = None,
) -> list[PrayerPosition]:
    """Turn an unordered ``Marker`` stream into an ordered list of ``PrayerPosition``s.

    Args:
        markers: Detected phrase markers (any order). Only takbir / tasmi' (advancing)
            and tasleem (closing) markers affect the structure; other types are ignored
            as position boundaries.
        total_duration: File duration in seconds, used to close the final, open-ended
            position. ``None`` leaves the last position open (``end=None``).

    Returns:
        Positions ordered by time. With no advancing markers the whole recitation is a
        single ``qiyam`` position.
    """
    events = sorted(
        (m for m in markers if m.type in _ADVANCING or m.type == "tasleem"),
        key=lambda m: m.time,
    )

    positions: list[PrayerPosition] = []
    cycle_pos = 0
    rakah = 1
    start = 0.0
    opened_by: Optional[str] = None

    for m in events:
        positions.append(
            _position(
                len(positions),
                _POSITION_CYCLE[cycle_pos],
                rakah,
                start,
                m.time,
                opened_by,
                m.id,
            )
        )
        start = m.time
        opened_by = m.id

        if m.type == "tasleem":
            # The tasleem closes the prayer; emit it as the final position and stop.
            positions.append(
                _position(len(positions), "tasleem", rakah, start, total_duration, m.id, None)
            )
            return positions

        cycle_pos += 1
        if cycle_pos >= len(_POSITION_CYCLE):
            cycle_pos = 0
            rakah += 1

    # No tasleem seen: close the position left open at the end of the file.
    positions.append(
        _position(len(positions), _POSITION_CYCLE[cycle_pos], rakah, start, total_duration, opened_by, None)
    )
    return positions
