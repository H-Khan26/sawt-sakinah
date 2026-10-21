"""Typed errors: extraction failures, plus the job error recorded for a cancelled job.

The extraction layer maps yt-dlp's generic ``DownloadError`` (and the upload importer's
failure modes) onto these so callers (and the API) can branch on a stable error type
instead of matching on message text. Extraction errors carry a user-facing message, an
``action`` the user can take and, when known, the ``platform`` involved. See docs/audio/01.
"""

from __future__ import annotations

from typing import Literal, Optional

#: What the user can do about an extraction failure: change the sign-in cookies in
#: Settings, update the downloader (yt-dlp), update the app, or try again later.
Action = Literal["cookies", "update_downloader", "update_app", "retry_later"]

_CLASS_DEFAULT = object()


class ExtractionError(Exception):
    """Base class for all extraction/ingestion failures.

    ``action`` and ``platform`` default per class; an instance can override either.
    ``platform`` is a registry id (``"instagram"``), or ``None`` when no site is involved.
    """

    action: Optional[Action] = None
    platform: Optional[str] = None

    def __init__(
        self,
        *args: object,
        platform: Optional[str] = None,
        action: Optional[Action] | object = _CLASS_DEFAULT,
    ) -> None:
        super().__init__(*args)
        if platform is not None:
            self.platform = platform
        if action is not _CLASS_DEFAULT:
            self.action = action  # type: ignore[assignment]

    def error_fields(self) -> dict[str, Optional[str]]:
        """The fields a failed job and an API error body carry next to the error type."""
        return {"error_action": self.action, "platform": self.platform}


class InvalidInputError(ExtractionError):
    """The supplied text is not a usable link (empty, no http(s) scheme, no dotted host)."""


class UnsupportedPlatformError(InvalidInputError):
    """The link's host is not one of the supported platforms."""


class UnsupportedLinkError(InvalidInputError):
    """The link is on a supported platform but is not a single post (a profile, a
    playlist, a photo), or the post points at another site."""


# -- upload ingestion (extraction/importer.py) --------------------------------


class UnsupportedMediaError(ExtractionError):
    """The uploaded file's type is not accepted, or ffmpeg cannot decode it."""


class NoAudioStreamError(ExtractionError):
    """The upload or post has no audio to import (a photo, a silent video)."""


class FileTooLargeError(ExtractionError):
    """The upload or linked video exceeds the configured size or duration cap."""


class PrivateVideoError(ExtractionError):
    """The video is private and cannot be accessed."""


class AgeRestrictedError(ExtractionError):
    """The video is age-restricted and requires sign-in."""

    action = "cookies"


class RegionLockedError(ExtractionError):
    """The video is not available in the current region."""


class LiveStreamError(ExtractionError):
    """The target is a live stream, which is not supported."""


class VideoUnavailableError(ExtractionError):
    """The video was removed, deleted, or is otherwise unavailable."""


class DrmProtectedError(ExtractionError):
    """The video is DRM protected, so its media can't be downloaded."""


class PlatformUnavailableError(ExtractionError):
    """The active yt-dlp can't import from this platform: its extractor is missing or
    marked broken, it is older than the platform's minimum, or a required helper (Deno)
    is missing."""

    action = "update_downloader"


class ExtractorOutdatedError(ExtractionError):
    """yt-dlp failed in a way that points at a site change it doesn't handle yet."""

    action = "update_downloader"


class LoginRequiredError(ExtractionError):
    """The site wants the user signed in (a private or protected post, a login wall)."""

    action = "cookies"


class RateLimitedError(ExtractionError):
    """The site is limiting requests from this network (HTTP 429)."""

    action = "retry_later"


class NetworkError(ExtractionError):
    """The site could not be reached (no connection, DNS, timeout, TLS)."""

    action = "retry_later"


class JobCancelledError(Exception):
    """A job was stopped, or dropped before it ran, because the app was shutting down."""


class YouTubeBotCheckError(ExtractionError):
    """YouTube refused the download because it suspects automated access (its bot check,
    or the transient "content isn't available, try again later" block)."""

    action = "cookies"


class CookiesError(ExtractionError):
    """The sign-in cookies chosen in Settings (a browser or a cookies.txt file) can't be
    read."""

    action = "cookies"


class ProjectInUseError(Exception):
    """A project's files are still open (e.g. by playback), so it can't be deleted now."""


class ProjectUnreadableError(Exception):
    """A project's ``project.json`` can't be loaded; the message says why, for the user."""


class ProjectTooNewError(ProjectUnreadableError):
    """A project was saved by a newer app version (its ``schema_version`` is ahead)."""
