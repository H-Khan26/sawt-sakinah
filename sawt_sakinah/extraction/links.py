"""Turn pasted text into a link to one post on a supported platform.

The stages run in order, each with its own error: :func:`parse_link` (is it a link at
all), :func:`platform_for_url` (is the site supported), :func:`resolve_link`'s share-link
hop (the one stage that needs the network), and :func:`match_link` (is it a single post,
judged by the platform's yt-dlp extractors). :func:`check_link` runs the offline stages
for a synchronous check before a job starts. YouTube links keep their canonical
``watch?v=`` form, so cache keys and source ids of earlier imports still match.
"""

from __future__ import annotations

import dataclasses
import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional
from urllib.parse import parse_qs, urljoin, urlsplit, urlunsplit

from ..models.errors import (
    InvalidInputError,
    LoginRequiredError,
    UnsupportedLinkError,
    UnsupportedPlatformError,
)
from . import compat
from .platforms import Platform, platform_for_host, supported_labels

if TYPE_CHECKING:  # pragma: no cover - typing only; yt-dlp is imported lazily
    from yt_dlp import YoutubeDL

_log = logging.getLogger(__name__)

_NOT_A_LINK = "That isn't a link. Paste the address of a post or video."

# A leading URL scheme ("https://"); a "://" later on belongs to the query.
_SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*://", re.I)

# -- YouTube's canonical form -----------------------------------------------------------

_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
}
_SHORT_HOST = "youtu.be"
_YOUTUBE_WATCH = "https://www.youtube.com/watch?v={}"


def _youtube_video_id(url: str) -> Optional[str]:
    """The 11-character video id of a YouTube link, or ``None`` when it has none.

    Accepts ``youtu.be/<id>``, ``/watch?v=<id>``, ``/shorts/<id>``, ``/embed/<id>`` and
    ``/v/<id>``. A playlist link with no video, a channel or any other page has no id.
    """
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    if host == _SHORT_HOST:
        vid = parsed.path.lstrip("/").split("/")[0]
        return vid if _VIDEO_ID_RE.match(vid) else None
    if host not in _YOUTUBE_HOSTS:
        return None
    query = parse_qs(parsed.query)
    if query.get("v"):
        vid = query["v"][0]
        return vid if _VIDEO_ID_RE.match(vid) else None
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) >= 2 and parts[0] in {"shorts", "embed", "v"} and _VIDEO_ID_RE.match(parts[1]):
        return parts[1]
    return None


# -- the stages -------------------------------------------------------------------------


@dataclass(frozen=True)
class ResolvedLink:
    """A link matched to one post: what to hand yt-dlp and how to cache the result."""

    platform: Platform
    url: str             # the URL handed to yt-dlp (share links already resolved)
    extractor_key: str   # "Instagram"
    post_id: str         # from ie.get_temp_id(url)
    cache_key: str       # "instagram:C9x…" (YouTube: its canonical watch?v= URL)
    is_share_link: bool = False


def parse_link(text: str) -> str:
    """The pasted ``text`` as an http(s) URL; raises :class:`InvalidInputError`.

    Trims it and adds ``https://`` when no scheme is given. A bare 11-character YouTube
    video id is accepted too and becomes its watch URL.
    """
    candidate = (text or "").strip()
    if not candidate:
        raise InvalidInputError("Paste a link to a post or video.")
    if _VIDEO_ID_RE.match(candidate):
        return _YOUTUBE_WATCH.format(candidate)
    if any(ch.isspace() for ch in candidate):
        raise InvalidInputError(_NOT_A_LINK)
    if not _SCHEME.match(candidate):
        candidate = f"https://{candidate}"
    try:
        parts = urlsplit(candidate)
        host = (parts.hostname or "").rstrip(".")
    except ValueError:
        raise InvalidInputError(_NOT_A_LINK) from None
    if parts.scheme.lower() not in ("http", "https") or "." not in host:
        raise InvalidInputError(_NOT_A_LINK)
    return candidate


def _display_host(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def platform_for_url(url: str) -> Platform:
    """The platform ``url`` belongs to (by host suffix); raises
    :class:`UnsupportedPlatformError`."""
    platform = platform_for_host(urlsplit(url).hostname or "")
    if platform is None:
        raise UnsupportedPlatformError(
            f"Links from {_display_host(url)} aren't supported. You can import from "
            f"{supported_labels()}."
        )
    return platform


def is_share_link(url: str, platform: Platform) -> bool:
    """Whether ``url`` is one of the platform's share links, which only redirect."""
    return any(re.search(p, url, re.I) for p in platform.share_patterns)


def _with_www(url: str) -> Optional[str]:
    """``url`` with an ``m.``/``mobile.`` host swapped for ``www.``, or ``None``.

    Some extractors only accept the desktop host (Instagram's regex allows ``www.`` only).
    """
    parts = urlsplit(url)
    host = parts.hostname or ""
    for prefix in ("m.", "mobile."):
        if host.lower().startswith(prefix):
            netloc = parts.netloc.replace(host, "www." + host[len(prefix):], 1)
            return urlunsplit(parts._replace(netloc=netloc))
    return None


def match_link(url: str, platform: Platform) -> ResolvedLink:
    """Match ``url`` to one of the platform's single-post extractors, offline.

    The platform's ``reject_patterns`` run first; then the first extractor whose
    ``suitable(url)`` accepts it wins and its ``get_temp_id(url)`` names the post.

    Raises:
        UnsupportedLinkError: If a reject pattern matches or no extractor accepts the link.
    """
    for pattern, message in platform.reject_patterns:
        if re.search(pattern, url, re.I):
            raise UnsupportedLinkError(message, platform=platform.id)

    if platform.id == "youtube":
        vid = _youtube_video_id(url)
        if vid is None:
            raise UnsupportedLinkError(platform.wrong_link_hint, platform=platform.id)
        # Kept byte-identical: earlier imports' cache keys and source ids hash this URL.
        url = _YOUTUBE_WATCH.format(vid)

    candidates = [url]
    desktop = _with_www(url)
    if desktop is not None:
        candidates.append(desktop)
    for key in platform.extractors:
        ie = compat.extractor_class(key)
        if ie is None:
            continue
        for candidate in candidates:
            if not ie.suitable(candidate):
                continue
            post_id = ie.get_temp_id(candidate) or candidate
            if platform.id == "youtube":
                cache_key = candidate
            else:
                cache_key = f"{platform.id}:{post_id}"
                index = re.search(platform.media_index, candidate) if platform.media_index else None
                if index:
                    cache_key += f"/{index.group(1)}"
            return ResolvedLink(platform, candidate, key, post_id, cache_key)
    raise UnsupportedLinkError(platform.wrong_link_hint, platform=platform.id)


def check_link(text: str) -> ResolvedLink | Platform:
    """The offline stages, for a check before any job starts.

    Returns the matched link, or for a share link (which needs the network to resolve)
    just its platform.

    Raises:
        InvalidInputError: If ``text`` is not a link.
        UnsupportedPlatformError: If the site is not supported.
        PlatformUnavailableError: If the active yt-dlp can't import from the site.
        UnsupportedLinkError: If the link is not a single post.
    """
    url = parse_link(text)
    platform = platform_for_url(url)
    compat.require_available(platform)
    if is_share_link(url, platform):
        return platform
    return match_link(url, platform)


_LOGIN_PATH = re.compile(r"/(?:accounts/)?login(?:\.php)?(?:/|$)", re.I)


def _follow(url: str, platform: Platform, ydl: "YoutubeDL") -> str:
    """Where a share link redirects to: one HEAD request, or a GET if HEAD fails."""
    from yt_dlp.networking import Request
    from yt_dlp.networking.exceptions import HTTPError

    headers = {"User-Agent": platform.share_user_agent} if platform.share_user_agent else {}
    failure: Optional[HTTPError] = None
    for method in ("HEAD", "GET"):
        try:
            with ydl.urlopen(Request(url, headers=headers, method=method)) as response:
                return response.url
        except HTTPError as err:
            landed = err.response.url
            err.response.close()
            # A post page can refuse the request while the redirect itself worked.
            if landed and landed != url and not is_share_link(landed, platform):
                return landed
            failure = err
    assert failure is not None
    raise failure


def resolve_link(text: str, ydl: "YoutubeDL") -> ResolvedLink:
    """Like :func:`check_link`, but follows a share link to the post it points at.

    The request goes through ``ydl`` so its cookies, impersonation and proxy apply.
    yt-dlp's own errors (HTTP, network, cookies) propagate for :func:`.classify.classify`.
    The platform's availability is not checked here.

    Raises:
        InvalidInputError, UnsupportedPlatformError, UnsupportedLinkError: As
            :func:`check_link`; also when a share link leads off the supported sites or
            to something other than a post.
        LoginRequiredError: If the share link redirects to a sign-in page with no post.
    """
    url = parse_link(text)
    platform = platform_for_url(url)
    if not is_share_link(url, platform):
        return match_link(url, platform)

    landed = _follow(url, platform, ydl)
    _log.info("share link %s resolved to %s", url, landed)
    if _LOGIN_PATH.search(urlsplit(landed).path):
        # A login wall keeps the post's address in ``next``; without it nothing is left.
        target = parse_qs(urlsplit(landed).query).get("next", [None])[0]
        if not target:
            raise LoginRequiredError(
                f"{platform.label} asked for sign-in before opening this link. Turn on "
                "sign-in cookies in Settings and try again.",
                platform=platform.id,
            )
        landed = urljoin(landed, target)
    final = platform_for_url(landed)
    if is_share_link(landed, final):
        raise UnsupportedLinkError(final.wrong_link_hint, platform=final.id)
    return dataclasses.replace(match_link(landed, final), is_share_link=True)
