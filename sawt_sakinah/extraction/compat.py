"""Check each platform against the active yt-dlp and the helpers this install has.

A platform is available when its extractors exist in the active yt-dlp and report
``working()``, the yt-dlp version is at least the platform's ``min_ytdlp``, and its
required capabilities (``needs``) are present. A missing preferred capability
(``prefers``) leaves it available but limited, as does a missing Deno in a source checkout. yt-dlp is chosen once per process (a
downloaded update or the bundled copy, see :mod:`sawt_sakinah.ytdlp_updates`), so every
result here is computed once and kept.
"""

from __future__ import annotations

import functools
import logging
import threading
from dataclasses import dataclass
from typing import Optional

from .. import runtime
from ..models.errors import Action, PlatformUnavailableError
from ..ytdlp_updates import import_yt_dlp, version_key
from .platforms import Capability, Platform

_log = logging.getLogger(__name__)

_LOCK = threading.Lock()

#: How the messages name each capability.
_CAPABILITY_NAMES: dict[Capability, str] = {
    "impersonate": "browser impersonation (curl_cffi)",
    "js_runtime": "Deno (the JavaScript runtime for YouTube's player)",
}


@dataclass(frozen=True)
class PlatformStatus:
    """Whether a platform can be imported from with the active yt-dlp, and if not, why."""

    platform_id: str
    available: bool
    limited: bool             # available, but a preferred capability is missing
    reason: Optional[str]     # "Instagram imports need a newer downloader (2026.09.01 or later)."
    action: Optional[Action]  # what fixes it: "update_downloader", "update_app" or "cookies"
    ytdlp_version: str


@functools.cache
def ytdlp_version() -> str:
    """The active yt-dlp's version string."""
    import_yt_dlp()
    from yt_dlp.version import __version__

    return __version__


def extractor_class(ie_key: str) -> Optional[type]:
    """The active yt-dlp's extractor class for ``ie_key`` (``"Instagram"``), or ``None``."""
    import_yt_dlp()
    from yt_dlp.extractor import get_info_extractor

    try:
        return get_info_extractor(ie_key)
    except KeyError:
        return None


class _QuietLogger:
    """Keeps the probe's YoutubeDL off the console."""

    def debug(self, msg: str) -> None:
        pass

    info = warning = debug

    def error(self, msg: str) -> None:
        _log.debug("%s", msg)


def _can_impersonate() -> bool:
    """Whether yt-dlp has a request handler that can impersonate a browser."""
    yt_dlp = import_yt_dlp()
    from yt_dlp.networking.impersonate import ImpersonateTarget

    try:
        params = {"quiet": True, "no_warnings": True, "logger": _QuietLogger()}
        with yt_dlp.YoutubeDL(params, auto_init=False) as ydl:
            # Private API (yt-dlp marks it as future public API); the fallback below
            # covers a release that renames it.
            return bool(ydl._impersonate_target_available(ImpersonateTarget()))
    except AttributeError:
        _log.warning("yt-dlp has no _impersonate_target_available; probing curl_cffi")
    try:
        # Raises ImportError when curl_cffi is missing or outside yt-dlp's accepted range.
        import yt_dlp.networking._curlcffi  # noqa: F401
    except ImportError:
        return False
    return True


def _has_js_runtime() -> bool:
    try:
        runtime.tool_path("deno")
    except runtime.ToolNotFoundError:
        return False
    return True


_capabilities: Optional[frozenset[Capability]] = None


def capabilities() -> frozenset[Capability]:
    """The capabilities this install has, probed once per process."""
    global _capabilities
    with _LOCK:
        if _capabilities is None:
            found: set[Capability] = set()
            try:
                if _can_impersonate():
                    found.add("impersonate")
            except Exception:  # noqa: BLE001 - a failed probe means no impersonation
                _log.exception("impersonation probe failed")
            if _has_js_runtime():
                found.add("js_runtime")
            _capabilities = frozenset(found)
            _log.info("yt-dlp %s capabilities: %s", ytdlp_version(), sorted(found) or "none")
        return _capabilities


def _needs(platform: Platform) -> frozenset[Capability]:
    """The capabilities the platform can't do without here: Deno is bundled with the app,
    while a source checkout takes it from PATH and treats it as a preference."""
    if runtime.FROZEN:
        return platform.needs
    return platform.needs - {"js_runtime"}


def _status(platform: Platform) -> PlatformStatus:
    version = ytdlp_version()

    def unavailable(reason: str, action: Action) -> PlatformStatus:
        return PlatformStatus(platform.id, False, False, reason, action, version)

    label = platform.label
    current, minimum = version_key(version), version_key(platform.min_ytdlp)
    if current is not None and minimum is not None and current < minimum:
        return unavailable(
            f"{label} imports need a newer downloader ({platform.min_ytdlp} or later).",
            "update_downloader",
        )
    for key in platform.extractors:
        ie = extractor_class(key)
        if ie is None:
            # The version is new enough, so the extractor was renamed or dropped.
            return unavailable(
                f"{label} imports aren't available with this downloader ({version}). "
                "Check for an app update.",
                "update_app",
            )
        if not ie.working():
            return unavailable(
                f"This downloader ({version}) marks {label} as broken. A newer one may fix it.",
                "update_downloader",
            )
    have = capabilities()
    missing = sorted(_needs(platform) - have)
    if missing:
        return unavailable(
            f"{label} imports need {_CAPABILITY_NAMES[missing[0]]}, which this install is "
            "missing. Reinstall or update the app.",
            "update_app",
        )
    if "js_runtime" in platform.needs - have:
        # A source checkout without Deno on PATH: yt-dlp still gets some formats.
        return PlatformStatus(
            platform.id,
            True,
            True,
            f"Deno isn't on PATH, so {label} imports may fail or miss formats. Install "
            "Deno and restart the app.",
            None,
            version,
        )
    missing = sorted(platform.prefers - have)
    if missing:
        return PlatformStatus(
            platform.id,
            True,
            True,
            f"{label} often asks for sign-in without {_CAPABILITY_NAMES[missing[0]]}, "
            "which this install is missing. Turn on sign-in cookies in Settings, or update "
            "the app.",
            "cookies",
            version,
        )
    return PlatformStatus(platform.id, True, False, None, None, version)


_statuses: dict[str, PlatformStatus] = {}


def platform_status(platform: Platform) -> PlatformStatus:
    """The platform's status against the active yt-dlp, computed once per process."""
    status = _statuses.get(platform.id)
    if status is None:
        status = _status(platform)
        _statuses[platform.id] = status
        if not status.available or status.limited:
            _log.warning("%s: %s", platform.id, status.reason)
    return status


def require_available(platform: Platform) -> None:
    """Raise :class:`PlatformUnavailableError` when the platform can't be imported from."""
    status = platform_status(platform)
    if not status.available:
        raise PlatformUnavailableError(status.reason, platform=platform.id, action=status.action)


def newer_downloader() -> Optional[str]:
    """A yt-dlp version newer than the active one that the updater knows of, else ``None``.

    Either downloaded and waiting for a restart, or seen by the last update check.
    """
    from .. import ytdlp_updates

    try:
        state = ytdlp_updates.status()
    except Exception:  # noqa: BLE001 - only used to word an error
        _log.exception("could not read the yt-dlp update state")
        return None
    active = version_key(state.get("version"))
    if active is None:
        return None
    for candidate in (state.get("pending_version"), state.get("latest")):
        key = version_key(candidate)
        if key is not None and key > active:
            return candidate
    return None
