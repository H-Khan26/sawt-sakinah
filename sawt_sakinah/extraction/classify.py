"""Map a failed yt-dlp call to one of the typed extraction errors, in a fixed rule order.

Rules that read exception types and HTTP status come before rules that read text, and
yt-dlp's ``expected`` flag (False means it did not foresee the failure, usually a site
change) is the last resort before the generic fallback. The platform's own text rules
(``Platform.rules``) run before the generic ones. Every message is user-facing and names
the platform.
"""

from __future__ import annotations

import logging
import re
import traceback
from typing import Iterator, Optional

from ..models.errors import (
    AgeRestrictedError,
    CookiesError,
    DrmProtectedError,
    ExtractionError,
    ExtractorOutdatedError,
    LiveStreamError,
    LoginRequiredError,
    NetworkError,
    NoAudioStreamError,
    PrivateVideoError,
    RateLimitedError,
    RegionLockedError,
    UnsupportedLinkError,
    VideoUnavailableError,
)
from . import compat
from .platforms import AGE_GATE, FailureContext, Platform

_log = logging.getLogger(__name__)

#: Display names for the browsers cookies can come from (``schemas.COOKIE_BROWSERS``).
BROWSER_LABELS = {
    "chrome": "Chrome",
    "edge": "Microsoft Edge",
    "firefox": "Firefox",
    "brave": "Brave",
    "chromium": "Chromium",
    "vivaldi": "Vivaldi",
    "opera": "Opera",
    "safari": "Safari",
}

# yt-dlp's login hint (``InfoExtractor._login_hint``), which every site's
# ``raise_login_required`` appends.
_LOGIN_HINT = re.compile(r"--cookies\b")

# Messages for a post with nothing to download: yt-dlp's core ones, Instagram's and X's.
_NO_MEDIA = re.compile(
    r"no video formats found|requested format is not available|there is no video in this post"
    r"|no video could be found in this tweet|media #\d+ is not a video"
)
# FFmpegExtractAudio finding no audio track in a downloaded video.
_NO_AUDIO_TRACK = re.compile(r"unable to obtain file audio codec")

# Older text matches for failures that arrive without a typed exception.
_PRIVATE = re.compile(r"private video")
_REGION = re.compile(r"your country|region|geo.*block")
_LIVE = re.compile(r"live event|is live|live stream")
_UNAVAILABLE = re.compile(r"unavailable|has been removed|been terminated|twitter api says")

# Fallback for network failures that lost their TransportError on the way.
_NETWORK_HINTS = (
    "getaddrinfo",
    "urlopen error",
    "timed out",
    "name resolution",
    "network is unreachable",
    "connection refused",
    "connection reset",
    "remote end closed connection",
)

# Exceptions an extractor raises when the page no longer looks the way it expects.
_PARSE_FAILURES = (KeyError, TypeError, AttributeError, IndexError, ValueError)

# A source file inside the yt_dlp package, by absolute or bundle-relative path.
_YTDLP_FILE = re.compile(r"(?:^|[\\/])yt_dlp[\\/]")


def causes(err: BaseException) -> Iterator[BaseException]:
    """``err`` and every exception behind it: ``exc_info``, ``.cause``, ``__cause__`` and
    ``__context__``, outermost first, each once."""
    seen: set[int] = set()
    todo: list[Optional[BaseException]] = [err]
    while todo:
        exc = todo.pop(0)
        if exc is None or id(exc) in seen:
            continue
        seen.add(id(exc))
        yield exc
        exc_info = getattr(exc, "exc_info", None)
        if isinstance(exc_info, tuple) and len(exc_info) > 1:
            todo.append(exc_info[1])
        cause = getattr(exc, "cause", None)
        if isinstance(cause, BaseException):
            todo.append(cause)
        todo += [exc.__cause__, exc.__context__]


def raised_in_ytdlp(err: BaseException) -> bool:
    """Whether ``err`` was raised by yt-dlp's code (its innermost frame is in ``yt_dlp``).

    A frozen app records bundle-relative file names (``yt_dlp\\extractor\\…``).
    """
    frames = traceback.extract_tb(err.__traceback__)
    return bool(frames) and _YTDLP_FILE.search(frames[-1].filename) is not None


def is_ytdlp_failure(err: BaseException) -> bool:
    """Whether :func:`classify` should handle ``err``: a yt-dlp error, or a parse failure
    (``KeyError``, ``TypeError``, …) raised inside yt-dlp."""
    from yt_dlp.utils import YoutubeDLError

    if isinstance(err, YoutubeDLError):
        return True
    return isinstance(err, _PARSE_FAILURES) and raised_in_ytdlp(err)


def cookie_error(cookies: str, message: str, platform: Optional[Platform]) -> CookiesError:
    """The error for cookies yt-dlp could not load (``message`` is its text)."""
    pid = platform.id if platform else None
    if cookies == "file":
        return CookiesError(
            "Couldn't read the cookies.txt file chosen in Settings. Export it again from "
            "your browser, or turn sign-in cookies off in Settings.",
            platform=pid,
        )
    label = BROWSER_LABELS.get(cookies, cookies)
    if "could not find" in message.lower():
        site = platform.label if platform else "the site"
        return CookiesError(
            f"Couldn't find {label} cookies on this computer. Check that {label} is "
            f"installed and signed in to {site}, or choose another option in Settings.",
            platform=pid,
        )
    return CookiesError(
        f"Couldn't read your {label} cookies. Some browsers lock or encrypt them while "
        f"they run: close {label} and try again, or choose another browser or a "
        "cookies.txt file in Settings.",
        platform=pid,
    )


def _root_error(chain: list[BaseException]) -> Optional[BaseException]:
    """The innermost ``ExtractorError`` of a cause chain: the one that says what failed."""
    from yt_dlp.utils import ExtractorError

    errors = [e for e in chain if isinstance(e, ExtractorError)]
    return errors[-1] if errors else None


def root_message(err: BaseException) -> str:
    """yt-dlp's own text for a failure: the root ``ExtractorError`` with its
    ``"[ie] id:"`` prefix, else ``str(err)``."""
    root = _root_error(list(causes(err)))
    return str(root if root is not None else err)


def no_audio_error(platform: Platform, has_video: bool = False) -> NoAudioStreamError:
    """The error for a post with nothing to import: no media at all, or (``has_video``) a
    video without an audio track."""
    if has_video:
        text = f"This {platform.item} has no audio track to import."
    else:
        text = f"This {platform.item} has no video or audio to import."
    return NoAudioStreamError(text, platform=platform.id)


def unavailable_error(platform: Platform) -> VideoUnavailableError:
    """The error for a post that is gone or never existed."""
    return VideoUnavailableError(
        f"This {platform.item} isn't available. It may have been deleted.",
        platform=platform.id,
    )


def _outdated(ctx: FailureContext) -> ExtractionError:
    newer = (
        f" A newer one ({ctx.newer_downloader}) is available."
        if ctx.newer_downloader
        else " Check for an update."
    )
    return ExtractorOutdatedError(
        f"{ctx.platform.label} changed something this downloader "
        f"({compat.ytdlp_version()}) can't handle.{newer}",
        platform=ctx.platform.id,
    )


def _login(ctx: FailureContext) -> ExtractionError:
    p = ctx.platform
    if ctx.cookies is not None:
        source = (
            "the cookies.txt file" if ctx.cookies == "file"
            else BROWSER_LABELS.get(ctx.cookies, ctx.cookies)
        )
        return LoginRequiredError(
            f"{p.label} still asked for sign-in. Make sure you are signed in to {p.label} "
            f"in {source} (or export the cookies again), then try again.",
            platform=p.id,
        )
    if "rate-limit" in ctx.message.lower() or "rate limit" in ctx.message.lower():
        text = (
            f"{p.label} wants you to sign in, or is limiting anonymous requests from this "
            "network. Turn on sign-in cookies in Settings, or try again later."
        )
    else:
        text = (
            f"{p.label} needs you to be signed in to import this {p.item}. Turn on sign-in "
            "cookies in Settings and try again."
        )
    missing = p.prefers - compat.capabilities()
    if "impersonate" in missing:
        text += (
            f" Without browser impersonation, which this install is missing, {p.label} "
            "asks for sign-in more often."
        )
    return LoginRequiredError(text, platform=p.id)


def _worded(cls: type[ExtractionError], ctx: FailureContext) -> ExtractionError:
    """``cls`` with its standard message for the platform."""
    p = ctx.platform
    if cls is ExtractorOutdatedError:
        return _outdated(ctx)
    if cls is LoginRequiredError:
        return _login(ctx)
    if cls is NoAudioStreamError:
        return no_audio_error(p)
    if cls is VideoUnavailableError:
        return unavailable_error(p)
    messages: dict[type[ExtractionError], str] = {
        PrivateVideoError: f"This {p.item} is private.",
        AgeRestrictedError: (
            f"This {p.item} is age-restricted. Turn on sign-in cookies in Settings with an "
            f"account that may watch it, and try again."
        ),
        RegionLockedError: f"This {p.item} isn't available in your country.",
        LiveStreamError: "Live streams can't be imported. Try again after it ends.",
        DrmProtectedError: f"This {p.item} is copy-protected and can't be imported.",
        NetworkError: f"Couldn't reach {p.label}. Check your internet connection.",
    }
    return cls(messages[cls], platform=p.id)


def classify(err: BaseException, platform: Platform, cookies: Optional[str]) -> ExtractionError:
    """The typed error for a failed yt-dlp call on ``platform``.

    ``cookies`` names the cookie source in use (a browser id or ``"file"``) or is
    ``None``; it shapes the sign-in advice. The first matching rule wins:

    1. cookies failed to load; 2. the platform's own text rules; 3. geo restriction;
    4. HTTP 429, then 404/410 and 5xx; 5. yt-dlp's sign-in hint; 6. no media, or
    no audio track; 7. DRM; 8. older texts (private, age, region, live, unavailable); 9. a network
    failure; 10. the post leads to another site; 11. an unforeseen failure in the
    extractor (outdated); 12. a generic message.
    """
    from yt_dlp.cookies import CookieLoadError
    from yt_dlp.networking.exceptions import HTTPError, TransportError
    from yt_dlp.utils import GeoRestrictedError, RegexNotFoundError

    chain = list(causes(err))
    root = _root_error(chain)
    http = next((e for e in chain if isinstance(e, HTTPError)), None)
    message = root.orig_msg if root is not None else str(err)
    low = message.lower()
    ctx = FailureContext(platform, message, cookies, compat.newer_downloader())
    label = platform.label

    def worded(cls: type[ExtractionError]) -> ExtractionError:
        return _worded(cls, ctx)

    if any(isinstance(e, CookieLoadError) for e in chain):
        return cookie_error(cookies or "", str(err), platform)

    for rule in platform.rules:
        if rule.pattern.search(low):
            if isinstance(rule.build, type):
                return worded(rule.build)
            return rule.build(ctx)

    if any(isinstance(e, GeoRestrictedError) for e in chain):
        return worded(RegionLockedError)
    if http is not None:
        if http.status == 429:
            return RateLimitedError(
                f"{label} is limiting requests from this network. Try again later"
                + (" or turn on sign-in cookies in Settings." if cookies is None else "."),
                platform=platform.id,
                action="cookies" if cookies is None else "retry_later",
            )
        if http.status in (404, 410):
            return worded(VideoUnavailableError)
        if http.status >= 500:
            return NetworkError(
                f"{label} isn't responding right now. Try again later.", platform=platform.id
            )
    if _LOGIN_HINT.search(message):
        return worded(LoginRequiredError)
    if _NO_MEDIA.search(low):
        return worded(NoAudioStreamError)
    if _NO_AUDIO_TRACK.search(low):
        return no_audio_error(platform, has_video=True)
    if "drm protected" in low:
        return worded(DrmProtectedError)
    if _PRIVATE.search(low):
        return worded(PrivateVideoError)
    if AGE_GATE.search(low):
        return worded(AgeRestrictedError)
    if _REGION.search(low):
        return worded(RegionLockedError)
    if _LIVE.search(low):
        return worded(LiveStreamError)
    if _UNAVAILABLE.search(low):
        return worded(VideoUnavailableError)
    if http is None and (
        any(isinstance(e, TransportError) for e in chain)
        or any(hint in low for hint in _NETWORK_HINTS)
    ):
        return worded(NetworkError)
    if "no suitable extractor" in low:
        return UnsupportedLinkError(
            f"This {platform.item} links to content on another site, which can't be "
            f"imported from {label}.",
            platform=platform.id,
        )
    if (
        (root is not None and not root.expected)
        or any(isinstance(e, RegexNotFoundError) for e in chain)
        or any(isinstance(e, _PARSE_FAILURES) and raised_in_ytdlp(e) for e in chain)
    ):
        return worded(ExtractorOutdatedError)
    return ExtractionError(
        f"Couldn't import this {platform.item} from {label}. Try again later, or check for "
        "an app update.",
        platform=platform.id,
    )
