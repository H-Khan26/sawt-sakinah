"""Domain layer: interpret the marker stream as prayer structure.

Pure domain logic -- ``[Marker] -> [PrayerPosition]``. Never reads or writes audio.
See docs/audio/00-overview.md.
"""

from .structure import derive_structure

__all__ = ["derive_structure"]
