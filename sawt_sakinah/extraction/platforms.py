"""The registry of sites a link can be imported from, one :class:`Platform` per site.

Adding a site, or raising the yt-dlp version a site needs, is an edit to :data:`PLATFORMS`
(plus the site's id in ``models.sources.SourceKind``). Which link shapes count as a single
post comes from yt-dlp's own extractors (``suitable()``), so a yt-dlp update keeps that in
step without a regex here. :mod:`.links` matches links against the registry,
:mod:`.compat` checks each entry against the active yt-dlp, and :mod:`.classify` applies
the site-specific error ``rules`` before its generic ones.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Literal, Optional

from ..models.errors import (
    AgeRestrictedError,
    ExtractionError,
    ExtractorOutdatedError,
    PrivateVideoError,
    VideoUnavailableError,
    YouTubeBotCheckError,
)

#: Optional parts of the active install a site can depend on: browser impersonation
#: (curl_cffi) and a JavaScript runtime (Deno) for YouTube's player challenges.
Capability = Literal["impersonate", "js_runtime"]


@dataclass(frozen=True)
class FailureContext:
    """What an error rule knows about a failed import."""

    platform: "Platform"
    message: str                     # yt-dlp's text, without its "[ie] id:" prefix
    cookies: Optional[str]           # cookie source in use (a browser id or "file"), or None
    newer_downloader: Optional[str]  # a yt-dlp newer than the active one, when known


@dataclass(frozen=True)
class ErrorRule:
    """A site-specific failure text and the error it becomes.

    ``build`` is an error class (worded by :mod:`.classify` like its generic match) or a
    function that words the error itself.
    """

    pattern: re.Pattern[str]  # searched in the lowercased message
    build: type[ExtractionError] | Callable[[FailureContext], ExtractionError]


@dataclass(frozen=True)
class Platform:
    """One site links can be imported from."""

    id: str                          # "instagram"; also the AudioSource.source_kind
    label: str                       # "Instagram"
    item: str                        # what one link points at, for messages: "post"
    hosts: tuple[str, ...]           # registrable domains, matched by suffix
    extractors: tuple[str, ...]      # yt-dlp ie keys accepted as a single post
    wrong_link_hint: str             # shown when the host matches but no extractor does
    share_patterns: tuple[str, ...] = ()   # links resolved by one redirect hop
    share_user_agent: Optional[str] = None  # User-Agent for that hop, when the site needs one
    reject_patterns: tuple[tuple[str, str], ...] = ()  # (regex, message) checked before matching
    media_index: Optional[str] = None  # regex whose group 1 picks one media item of a post
    min_ytdlp: str = "2026.08.19"    # oldest yt-dlp known to work for this site
    needs: frozenset[Capability] = frozenset()    # without these the site is unavailable
    prefers: frozenset[Capability] = frozenset()  # without these the site is limited
    signin_often_needed: bool = False
    rules: tuple[ErrorRule, ...] = ()  # site-specific texts, checked before generic rules
    # Fetch a post's metadata even when it has no media, so a post the site returns nothing
    # for (no text, no author) can be told from a text-only one. Only for sites whose sole
    # "no formats" failure is a post without media.
    probe_empty_posts: bool = False
    canary_url: Optional[str] = None   # public post with audio for the daily link canary


# -- site-specific error rules ----------------------------------------------------------


# YouTube's refusals of a client it suspects is automated (typically a datacenter IP):
# "Sign in to confirm you're not a bot" and "This content isn't available, try again
# later". Both are transient blocks, not a missing video. The age gate ("Sign in to
# confirm your age") does not match.
_BOT_CHECK = re.compile(r"not a bot|(?:isn['\u2019]t|is not) available,? try again later")

# An age gate: a mention of age plus a confirm/restrict/sign-in request, in either order.
AGE_GATE = re.compile(
    r"^(?=.*(?:\bage\b|age[- ]restrict))(?=.*(?:confirm|restrict|sign in))", re.S
)


def _youtube_bot_check(ctx: FailureContext) -> ExtractionError:
    if ctx.cookies is not None:
        advice = (
            "Make sure you are signed in to YouTube where the cookies come from (or "
            "export them again), try again later, or check for an app update."
        )
    else:
        advice = "Turn on sign-in cookies in Settings and try again, or check for an app update."
    if "not a bot" in ctx.message.lower():
        return YouTubeBotCheckError(
            "YouTube asked to confirm this is not a bot and refused the download. " + advice,
            platform="youtube",
        )
    return YouTubeBotCheckError(
        "YouTube is refusing downloads from this network for now. " + advice,
        platform="youtube",
    )


def _facebook_cannot_parse(ctx: FailureContext) -> ExtractionError:
    # One message for a photo post, an unrecognised login wall and a real breakage, which
    # yt-dlp reports identically (an unexpected "Cannot parse data").
    if ctx.cookies is None:
        action = "cookies"
    elif ctx.newer_downloader:
        action = "update_downloader"
    else:
        action = None
    return ExtractionError(
        "Facebook didn't return a video for this link. It may be a photo post or need "
        "sign-in, or the downloader may need an update.",
        platform="facebook",
        action=action,
    )


YOUTUBE_RULES = (
    # Before the unavailable check: the "try again later" refusal starts "Video unavailable".
    ErrorRule(_BOT_CHECK, _youtube_bot_check),
    # YouTube's private and age gates carry yt-dlp's sign-in hint; they stay specific.
    ErrorRule(re.compile(r"private video"), PrivateVideoError),
    ErrorRule(AGE_GATE, AgeRestrictedError),
    # Every YouTube video has audio, so no formats at all means YouTube changed something.
    ErrorRule(
        re.compile(r"no video formats found|requested format is not available"),
        ExtractorOutdatedError,
    ),
)

# X names why a post is gone in one word ("Suspended") when it isn't a sign-in reason.
X_RULES = (ErrorRule(re.compile(r"^suspended\b"), VideoUnavailableError),)

FACEBOOK_RULES = (ErrorRule(re.compile(r"cannot parse data"), _facebook_cannot_parse),)


# -- the registry -----------------------------------------------------------------------


PLATFORMS: tuple[Platform, ...] = (
    Platform(
        "youtube",
        "YouTube",
        item="video",
        hosts=("youtube.com", "youtu.be"),
        extractors=("Youtube",),
        wrong_link_hint="Paste a link to a single video, not a channel or playlist.",
        min_ytdlp="2026.06.09",
        needs=frozenset({"js_runtime"}),
        rules=YOUTUBE_RULES,
        canary_url="https://www.youtube.com/watch?v=jNQXAC9IVRw",
    ),
    Platform(
        "instagram",
        "Instagram",
        item="post",
        hosts=("instagram.com", "instagr.am"),
        extractors=("Instagram",),
        wrong_link_hint="Paste a link to a single post or reel, not a profile, story or hashtag.",
        share_patterns=(r"instagram\.com/share/", r"instagr\.am/"),
        prefers=frozenset({"impersonate"}),
        signin_often_needed=True,
        canary_url="https://www.instagram.com/reel/CDUMkliABpa/",
    ),
    Platform(
        "x",
        "X",
        item="post",
        hosts=("x.com", "twitter.com", "t.co"),
        extractors=("Twitter",),
        wrong_link_hint="Paste a link to a single post (x.com/<name>/status/…).",
        share_patterns=(r"^https?://t\.co/",),
        # t.co answers a browser with an HTML page; other clients get the redirect.
        share_user_agent="curl",
        media_index=r"/status(?:es)?/\d+/(?:video|photo)/(\d+)",
        rules=X_RULES,
        # A missing post fails like a text-only one ("No video could be found in this tweet").
        probe_empty_posts=True,
        canary_url="https://x.com/captainamerica/status/719944021058060289",
    ),
    Platform(
        "facebook",
        "Facebook",
        item="video",
        hosts=("facebook.com", "fb.watch", "fb.com"),
        extractors=("Facebook", "FacebookReel"),
        wrong_link_hint="Paste a link to a single video or reel, not a page or profile.",
        share_patterns=(r"facebook\.com/share/", r"fb\.watch/"),
        reject_patterns=(
            (r"photo\.php|/photos?/", "That's a photo. Paste a link to a video or reel."),
        ),
        signin_often_needed=True,
        rules=FACEBOOK_RULES,
        canary_url="https://www.facebook.com/cnn/videos/10155529876156509/",
    ),
)

_BY_ID = {p.id: p for p in PLATFORMS}


def get_platform(platform_id: str) -> Platform:
    """The registry entry for ``platform_id``; raises ``KeyError`` for an unknown id."""
    return _BY_ID[platform_id]


def platform_for_host(host: str) -> Optional[Platform]:
    """The platform whose hosts include ``host`` or a parent domain of it, else ``None``."""
    host = host.lower().rstrip(".")
    for platform in PLATFORMS:
        if any(host == h or host.endswith("." + h) for h in platform.hosts):
            return platform
    return None


def supported_labels() -> str:
    """The platform labels as a sentence list: ``"YouTube, Instagram, X and Facebook"``."""
    labels = [p.label for p in PLATFORMS]
    return labels[0] if len(labels) == 1 else ", ".join(labels[:-1]) + " and " + labels[-1]
