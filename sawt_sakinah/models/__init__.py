"""Shared data contracts passed between extraction, detection, editing, and the API.

Defined once as pydantic v2 models and shared across layers (and mirrored by the
frontend). Times are always in seconds (float). See docs/audio/05-data-model-and-api.md.
"""

from .segments import SilenceSegment
from .markers import Marker
from .sources import AudioSource
from .edl import EditOperation, EditDecisionList
from .structure import PrayerPosition
from .project import Project, ProjectStatus, ExportArtifact
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
    "Marker",
    "AudioSource",
    "EditOperation",
    "EditDecisionList",
    "PrayerPosition",
    "Project",
    "ProjectStatus",
    "ExportArtifact",
    "ExtractionError",
    "InvalidInputError",
    "PrivateVideoError",
    "AgeRestrictedError",
    "RegionLockedError",
    "LiveStreamError",
    "VideoUnavailableError",
]
