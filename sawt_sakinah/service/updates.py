"""Checks the project's GitHub releases for a newer version (notification only).

When the ``update_check`` preference is on, :func:`check_for_update` asks GitHub for the
latest release at most once per ``app.update_check_interval_hours`` and caches the answer
in ``update-check.json`` in the data directory. A failed check is retried after an hour.
Network and parse failures are logged and never raised: the result then simply says no
update is available. Nothing is downloaded or installed.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

from pydantic import BaseModel

from .. import __version__, runtime
from ..config import CONFIG
from ..fileio import replace_file
from .preferences import load_preferences

_log = logging.getLogger(__name__)
_LOCK = threading.Lock()
_CACHE_FILE = "update-check.json"
_RETRY_AFTER_FAILURE = 3600.0
_MAX_RESPONSE_BYTES = 1024 * 1024
_REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
_VERSION = re.compile(r"v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?")


class UpdateStatus(BaseModel):
    """Body of ``GET /app/update``."""

    current: str
    latest: Optional[str] = None
    url: Optional[str] = None
    update_available: bool = False


def parse_version(text: str) -> Optional[tuple]:
    """Sortable key for a ``1.2.3`` / ``v1.2.3-beta.1`` tag; ``None`` when it isn't one.

    A pre-release sorts before its release.
    """
    m = _VERSION.fullmatch(text.strip())
    if m is None:
        return None
    major, minor, patch, pre = m.groups()
    return (int(major), int(minor), int(patch), pre is None, pre or "")


def _normalize(tag: str) -> str:
    tag = tag.strip()
    return tag[1:] if tag[:1] in ("v", "V") else tag


def _cache_path() -> Path:
    return runtime.data_dir() / _CACHE_FILE


def _read_cache(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_cache(path: Path, data: dict) -> None:
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        replace_file(tmp, path)
    except OSError as exc:
        _log.warning("could not save the update check result: %s", exc)


def fetch_latest_release(repo: str, timeout: float) -> tuple[Optional[str], Optional[str]]:
    """``(version, release page URL)`` of the repo's latest published release.

    ``(None, None)`` when the repo has no release yet. Raises on network or parse errors.
    """
    if not _REPO.fullmatch(repo):
        raise ValueError(f"app.release_repo must look like 'owner/repo', got {repo!r}")
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/releases/latest",
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": f"SawtSakinah/{__version__}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:  # noqa: S310 (fixed https URL)
            body = res.read(_MAX_RESPONSE_BYTES)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None, None
        raise
    data = json.loads(body)
    tag = data.get("tag_name") if isinstance(data, dict) else None
    if not isinstance(tag, str) or parse_version(tag) is None:
        raise ValueError(f"unexpected release tag {tag!r}")
    page = data.get("html_url")
    # Only ever hand the UI a link into this repo on GitHub.
    if not (isinstance(page, str) and page.startswith(f"https://github.com/{repo}/")):
        page = f"https://github.com/{repo}/releases/latest"
    return _normalize(tag), page


def _refresh(path: Path, cache: dict, repo: str, now: float) -> dict:
    """Ask GitHub and return the new cache contents (the old ones, marked, on failure)."""
    try:
        latest, url = fetch_latest_release(repo, CONFIG.app.update_check_timeout_sec)
    except Exception as exc:  # noqa: BLE001 - an update check must never break the app
        _log.info("update check failed: %s", exc)
        # Keep the repo so the next call sees this failure and backs off.
        cache = {**cache, "repo": repo, "failed_at": now}
    else:
        cache = {"repo": repo, "checked_at": now, "latest": latest, "url": url}
    _write_cache(path, cache)
    return cache


def check_for_update(force: bool = False) -> UpdateStatus:
    """The update status, refreshed from GitHub when the cached answer is stale."""
    current = __version__
    prefs = load_preferences()
    if not prefs.update_check:
        return UpdateStatus(current=current)

    repo = CONFIG.app.release_repo
    interval = CONFIG.app.update_check_interval_hours * 3600.0
    path = _cache_path()
    with _LOCK:
        cache = _read_cache(path)
        if cache.get("repo") != repo:
            cache = {}
        now = time.time()
        stale = not (0 <= now - float(cache.get("checked_at", 0)) < interval)
        backing_off = 0 <= now - float(cache.get("failed_at", -1e18)) < _RETRY_AFTER_FAILURE
        if force or (stale and not backing_off):
            cache = _refresh(path, cache, repo, now)

    latest = cache.get("latest") if isinstance(cache.get("latest"), str) else None
    url = cache.get("url") if isinstance(cache.get("url"), str) else None
    latest_key = parse_version(latest) if latest else None
    current_key = parse_version(current)
    dismissed = _normalize(prefs.dismissed_update) if prefs.dismissed_update else None
    available = bool(
        latest_key is not None
        and current_key is not None
        and latest_key > current_key
        and latest != dismissed
    )
    return UpdateStatus(current=current, latest=latest, url=url, update_available=available)


__all__ = ["UpdateStatus", "check_for_update", "fetch_latest_release", "parse_version"]
