"""Validate and normalize YouTube input (URL or bare video id)."""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse

from ..models.errors import InvalidInputError

_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
}
_SHORT_HOST = "youtu.be"


def extract_video_id(url_or_id: str) -> str:
    """Return the 11-character video id for a YouTube URL or bare id.

    Accepts a bare id, ``youtu.be/<id>``, ``/watch?v=<id>``, ``/shorts/<id>``, and
    ``/embed/<id>`` forms. A pure playlist link (``list=`` with no video) or a
    non-YouTube host raises :class:`InvalidInputError`.

    Args:
        url_or_id: A YouTube video URL or a bare 11-char video id.

    Raises:
        InvalidInputError: If the input is empty, a playlist, a non-YouTube host, or
            has no recoverable video id.
    """
    if not url_or_id or not url_or_id.strip():
        raise InvalidInputError("Empty URL or video id.")
    candidate = url_or_id.strip()

    # Bare video id.
    if _VIDEO_ID_RE.match(candidate):
        return candidate

    parsed = urlparse(candidate if "//" in candidate else f"https://{candidate}")
    host = (parsed.hostname or "").lower()
    if host.startswith("www."):
        pass  # keep www. forms in the allow-set below

    if host == _SHORT_HOST:
        vid = parsed.path.lstrip("/").split("/")[0]
        if _VIDEO_ID_RE.match(vid):
            return vid
        raise InvalidInputError(f"No video id in youtu.be link: {url_or_id}")

    if host not in _YOUTUBE_HOSTS:
        raise InvalidInputError(f"Not a YouTube URL: {url_or_id}")

    query = parse_qs(parsed.query)
    if "v" in query and query["v"]:
        vid = query["v"][0]
        if _VIDEO_ID_RE.match(vid):
            return vid
        raise InvalidInputError(f"Malformed video id in URL: {url_or_id}")

    # /shorts/<id>, /embed/<id>, /v/<id>
    parts = [p for p in parsed.path.split("/") if p]
    if parts and parts[0] in {"shorts", "embed", "v"} and len(parts) >= 2:
        if _VIDEO_ID_RE.match(parts[1]):
            return parts[1]

    if "list" in query:
        raise InvalidInputError(
            f"Playlist URLs are not supported; pass a single video: {url_or_id}"
        )
    raise InvalidInputError(f"Could not find a video id in: {url_or_id}")


def normalize_url(url_or_id: str) -> str:
    """Return the canonical ``https://www.youtube.com/watch?v=<id>`` form."""
    return f"https://www.youtube.com/watch?v={extract_video_id(url_or_id)}"
