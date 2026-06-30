"""Shared data contracts passed between extraction, detection, editing, and the API.

These are intentionally small and dependency-free (stdlib dataclasses). Times are
always in seconds (float). See docs/audio/05-data-model-and-api.md.
"""

from .segments import SilenceSegment
from .sources import AudioSource
from .errors import (
    ExtractionError,
    InvalidInputError,
    PrivateVideoError,
    AgeRestrictedError,
    RegionLockedError,
    LiveStreamError,
    VideoUnavailableError,
)

__all__ = [
    "SilenceSegment",
    "AudioSource",
    "ExtractionError",
    "InvalidInputError",
    "PrivateVideoError",
    "AgeRestrictedError",
    "RegionLockedError",
    "LiveStreamError",
    "VideoUnavailableError",
]
