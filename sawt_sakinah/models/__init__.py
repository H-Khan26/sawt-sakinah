"""Shared data contracts passed between extraction, detection, editing, and the API.

Defined once as pydantic v2 models and shared across layers (and mirrored by the
frontend). Times are always in seconds (float). See docs/audio/05-data-model-and-api.md.
"""

from .segments import SilenceSegment
from .sources import AudioSource
from .edl import EditOperation, EditDecisionList
from .surahs import SurahMap, SurahPassage
from .project import Project, ProjectStatus, ProjectSummary, ExportArtifact
from .errors import (
    Action,
    ExtractionError,
    InvalidInputError,
    UnsupportedPlatformError,
    UnsupportedLinkError,
    PrivateVideoError,
    AgeRestrictedError,
    RegionLockedError,
    LiveStreamError,
    VideoUnavailableError,
    UnsupportedMediaError,
    NoAudioStreamError,
    FileTooLargeError,
    YouTubeBotCheckError,
    CookiesError,
    DrmProtectedError,
    PlatformUnavailableError,
    ExtractorOutdatedError,
    LoginRequiredError,
    RateLimitedError,
    NetworkError,
    JobCancelledError,
    ProjectInUseError,
    ProjectUnreadableError,
    ProjectTooNewError,
)

__all__ = [
    "SilenceSegment",
    "AudioSource",
    "EditOperation",
    "EditDecisionList",
    "SurahMap",
    "SurahPassage",
    "Project",
    "ProjectStatus",
    "ProjectSummary",
    "ExportArtifact",
    "Action",
    "ExtractionError",
    "InvalidInputError",
    "UnsupportedPlatformError",
    "UnsupportedLinkError",
    "PrivateVideoError",
    "AgeRestrictedError",
    "RegionLockedError",
    "LiveStreamError",
    "VideoUnavailableError",
    "UnsupportedMediaError",
    "NoAudioStreamError",
    "FileTooLargeError",
    "YouTubeBotCheckError",
    "CookiesError",
    "DrmProtectedError",
    "PlatformUnavailableError",
    "ExtractorOutdatedError",
    "LoginRequiredError",
    "RateLimitedError",
    "NetworkError",
    "JobCancelledError",
    "ProjectInUseError",
    "ProjectUnreadableError",
    "ProjectTooNewError",
]
