"""Typed extraction errors.

The extraction layer maps yt-dlp's generic ``DownloadError`` (and the upload importer's
failure modes) onto these so callers (and the API) can branch on a stable error type
instead of matching on message text. Every typed error retains the original message.
See docs/audio/01.
"""

from __future__ import annotations


class ExtractionError(Exception):
    """Base class for all extraction/ingestion failures."""


class InvalidInputError(ExtractionError):
    """The supplied URL / id was malformed, a playlist, or a non-YouTube host."""


# -- upload ingestion (extraction/importer.py) --------------------------------


class UnsupportedMediaError(ExtractionError):
    """The uploaded file's type is not accepted, or ffmpeg cannot decode it."""


class NoAudioStreamError(ExtractionError):
    """The uploaded file contains no decodable audio stream (e.g. a silent video)."""


class FileTooLargeError(ExtractionError):
    """The upload or YouTube video exceeds the configured size or duration cap."""


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


class YouTubeBotCheckError(ExtractionError):
    """YouTube refused the download because it suspects automated access (its bot check,
    or the transient "content isn't available, try again later" block)."""
