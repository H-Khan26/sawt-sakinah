"""Typed extraction errors.

The extraction layer maps yt-dlp's generic ``DownloadError`` onto these so callers
(and the future API) can branch on a stable error type instead of matching on message
text. Every typed error retains the original yt-dlp message. See docs/audio/01.
"""

from __future__ import annotations


class ExtractionError(Exception):
    """Base class for all extraction failures."""


class InvalidInputError(ExtractionError):
    """The supplied URL / id was malformed, a playlist, or a non-YouTube host."""


class PrivateVideoError(ExtractionError):
    """The video is private and cannot be accessed."""


class AgeRestrictedError(ExtractionError):
    """The video is age-restricted and requires sign-in."""


class RegionLockedError(ExtractionError):
    """The video is not available in the current region."""


class LiveStreamError(ExtractionError):
    """The target is a live stream, which is not supported."""


class VideoUnavailableError(ExtractionError):
    """The video was removed, deleted, or is otherwise unavailable."""
