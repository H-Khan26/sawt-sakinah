"""Opt-in updates of the YouTube downloader (yt-dlp) from PyPI, ahead of an app release.

YouTube changes break a frozen yt-dlp within weeks. With the ``ytdlp_update`` preference
on (it is off by default), :func:`check_and_install` asks PyPI's JSON API for the newest
yt-dlp on the configured channel (``app.ytdlp_channel``: ``nightly``, the channel yt-dlp
recommends to regular users, or ``stable``) and for the yt-dlp-ejs version that release
pins (its challenge-solver scripts must match). It downloads both wheels over HTTPS from
``pypi.org`` / ``files.pythonhosted.org`` only (TLS verified with certifi), checks each
wheel's SHA-256 against the digest PyPI publishes before opening it, unpacks only the two
packages and their metadata (rejecting unsafe member names) and writes ``manifest.json``
with every file's SHA-256 into ``<data_dir>/plugins/<version>/``. Nothing downloaded is
run during the check, and pip is never used.

:func:`activate` runs once per process, before anything imports ``yt_dlp``
(``extraction/extractor.py`` calls it). With the preference on and a plugin set newer than
the bundled yt-dlp present, it checks every file against the manifest, puts the set ahead
of the bundled copy on ``sys.path`` and imports it. If verification, the import or the
version check fails, it drops the set (and remembers the version as bad), logs why and
leaves the bundled copy in place. With the preference off it removes downloaded sets, so
turning the option off returns to the bundled copy at the next launch.
"""

from __future__ import annotations

import hashlib
import importlib
import importlib.machinery
import importlib.util
import json
import logging
import re
import shutil
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Optional
from urllib.parse import urlsplit

from . import __version__, runtime
from .config import CONFIG
from .fileio import replace_file

_log = logging.getLogger(__name__)

#: Import names of the packages a plugin set holds, with their PyPI distribution names.
PACKAGES = {"yt_dlp": "yt-dlp", "yt_dlp_ejs": "yt-dlp-ejs"}

PLUGINS_DIR = "plugins"
MANIFEST = "manifest.json"
_STATE_FILE = "state.json"
_MANIFEST_FORMAT = 1

_ALLOWED_HOSTS = frozenset({"pypi.org", "files.pythonhosted.org"})
_PYPI = "https://pypi.org/pypi"
_TIMEOUT = 30.0
_JSON_LIMIT = 16 * 1024 * 1024
_WHEEL_LIMIT = 64 * 1024 * 1024
_UNPACKED_LIMIT = 256 * 1024 * 1024
_CHUNK = 1 << 16
_RETRY_AFTER_FAILURE = 3600.0
_MAX_BAD_VERSIONS = 20

# yt-dlp's date versions: "2026.8.19" (stable), "2026.10.10.233141.dev0" (nightly). The
# version module spells the nightly "2026.10.10.233141" and pads stable months ("2026.08.19").
_VERSION = re.compile(r"(\d+(?:\.\d+)*)(?:\.?dev(\d*))?")
_EJS_PIN = re.compile(
    r"yt-dlp-ejs\s*==\s*([0-9][0-9A-Za-z.]*)\s*;\s*extra\s*==\s*['\"]default['\"]"
)
_SHA256 = re.compile(r"[0-9a-f]{64}")

ProgressFn = Callable[[dict], None]

_ACTIVATE_LOCK = threading.Lock()
_CHECK_LOCK = threading.Lock()
_STATE_LOCK = threading.Lock()
_active: Optional[dict] = None


class YtdlpUpdateError(Exception):
    """A check or install failed (network, PyPI data, integrity or disk)."""


class YtdlpUpdateBusyError(YtdlpUpdateError):
    """Another check is already running."""


# -- versions ---------------------------------------------------------------------------


def version_key(text: Optional[str]) -> Optional[tuple]:
    """Sortable key for a yt-dlp style version; ``None`` for anything else.

    A dev (nightly) build sorts before the release with the same numbers, as in PEP 440.
    """
    if not isinstance(text, str):
        return None
    m = _VERSION.fullmatch(text.strip())
    if m is None:
        return None
    release = [int(part) for part in m.group(1).split(".")]
    while len(release) > 1 and release[-1] == 0:
        release.pop()
    dev = m.group(2)
    return (tuple(release), dev is None, int(dev) if dev else 0)


def _same_release(a: Optional[str], b: Optional[str]) -> bool:
    ka, kb = version_key(a), version_key(b)
    return ka is not None and kb is not None and ka[0] == kb[0]


def _read_module_attr(package: str, module: str, attr: str) -> Optional[str]:
    """``package.module.attr`` from the copy ``sys.path`` resolves now, without importing
    the package itself (its ``__init__`` would load all of yt-dlp)."""
    try:
        spec = importlib.util.find_spec(package)
        if spec is None or not spec.submodule_search_locations:
            return None
        sub = importlib.machinery.PathFinder.find_spec(
            f"{package}.{module}", list(spec.submodule_search_locations)
        )
        if sub is None or sub.loader is None:
            return None
        mod = importlib.util.module_from_spec(sub)
        sub.loader.exec_module(mod)
        value = getattr(mod, attr, None)
        return value if isinstance(value, str) else None
    except Exception:  # noqa: BLE001 - a version we can't read is reported as unknown
        _log.exception("could not read %s.%s", package, module)
        return None


# -- files ------------------------------------------------------------------------------


def plugins_dir() -> Path:
    return runtime.data_dir() / PLUGINS_DIR


def _enabled() -> bool:
    try:
        from .service.preferences import load_preferences

        return bool(load_preferences().ytdlp_update)
    except Exception:  # noqa: BLE001 - no preferences means the default (off)
        _log.exception("could not read the yt-dlp update preference")
        return False


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex[:8]}.tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    replace_file(tmp, path)


def _state(root: Path) -> dict:
    with _STATE_LOCK:
        return _read_json(root / _STATE_FILE)


def _update_state(root: Path, **changes: Any) -> dict:
    with _STATE_LOCK:
        state = {**_read_json(root / _STATE_FILE), **changes}
        try:
            _write_json(root / _STATE_FILE, state)
        except OSError as exc:
            _log.warning("could not save the yt-dlp update state: %s", exc)
        return state


def _mark_bad(root: Path, version: Optional[str]) -> None:
    if not version:
        return
    bad = [v for v in _state(root).get("bad_versions", []) if isinstance(v, str)]
    if version not in bad:
        _update_state(root, bad_versions=(bad + [version])[-_MAX_BAD_VERSIONS:])


def _remove(path: Path) -> None:
    shutil.rmtree(path, ignore_errors=True)
    if path.exists():
        _log.warning("could not remove %s; it is removed at a later launch", path)


def _installed_sets(root: Path) -> list[tuple[tuple, Path]]:
    """Plugin set directories (named by version) holding a manifest, newest first."""
    sets = []
    try:
        entries = list(root.iterdir())
    except OSError:
        return []
    for entry in entries:
        key = version_key(entry.name)
        if key is not None and entry.is_dir() and (entry / MANIFEST).is_file():
            sets.append((key, entry))
    return sorted(sets, key=lambda item: item[0], reverse=True)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_member(name: str) -> Optional[PurePosixPath]:
    """The relative path for a wheel member name, or ``None`` when it is unsafe."""
    if not name or name.startswith("/") or "\\" in name or ":" in name or "\x00" in name:
        return None
    parts = name.rstrip("/").split("/")
    if any(part in ("", ".", "..") for part in parts):
        return None
    return PurePosixPath(*parts)


def _load_manifest(set_dir: Path) -> dict:
    """The set's manifest, after checking every listed file against its SHA-256."""
    manifest = _read_json(set_dir / MANIFEST)
    files = manifest.get("files")
    if manifest.get("format") != _MANIFEST_FORMAT or not isinstance(files, dict) or not files:
        raise YtdlpUpdateError("the manifest is missing or invalid")
    if not isinstance(manifest.get("yt_dlp_ejs"), str):
        raise YtdlpUpdateError("the manifest names no yt-dlp-ejs version")
    if manifest.get("yt_dlp") != set_dir.name:
        raise YtdlpUpdateError("the manifest does not match its folder")
    root = set_dir.resolve()
    for name, digest in files.items():
        rel = _safe_member(name) if isinstance(name, str) else None
        if rel is None or not isinstance(digest, str):
            raise YtdlpUpdateError(f"the manifest lists an invalid file: {name!r}")
        path = (set_dir / rel).resolve()
        if not path.is_relative_to(root):
            raise YtdlpUpdateError(f"the manifest lists a file outside the set: {name!r}")
        try:
            actual = _sha256_file(path)
        except OSError as exc:
            raise YtdlpUpdateError(f"{name} is missing or unreadable ({exc})") from exc
        if actual != digest:
            raise YtdlpUpdateError(f"{name} does not match its recorded SHA-256")
    return manifest


# -- activation (process start) ---------------------------------------------------------


def _purge_modules() -> None:
    for name in list(sys.modules):
        if any(name == pkg or name.startswith(pkg + ".") for pkg in PACKAGES):
            del sys.modules[name]


def _import_set(set_dir: Path, manifest: dict) -> None:
    """Import yt-dlp and yt-dlp-ejs from ``set_dir`` and check they are the expected ones."""
    entry = str(set_dir)
    sys.path.insert(0, entry)
    importlib.invalidate_caches()
    try:
        import yt_dlp
        import yt_dlp.version
        import yt_dlp_ejs

        root = set_dir.resolve()
        for mod in (yt_dlp, yt_dlp_ejs):
            if not Path(mod.__file__ or "").resolve().is_relative_to(root):
                raise YtdlpUpdateError(f"{mod.__name__} loaded from {mod.__file__}, not the set")
        loaded = yt_dlp.version.__version__
        if not _same_release(loaded, manifest["yt_dlp"]):
            raise YtdlpUpdateError(f"yt-dlp reports {loaded}, expected {manifest['yt_dlp']}")
        if getattr(yt_dlp_ejs, "version", None) != manifest["yt_dlp_ejs"]:
            raise YtdlpUpdateError(
                f"yt-dlp-ejs reports {getattr(yt_dlp_ejs, 'version', None)}, "
                f"expected {manifest['yt_dlp_ejs']}"
            )
    except BaseException:
        _purge_modules()
        while entry in sys.path:
            sys.path.remove(entry)
        importlib.invalidate_caches()
        raise


def _activate() -> dict:
    bundled = _read_module_attr("yt_dlp", "version", "__version__")
    bundled_ejs = _read_module_attr("yt_dlp_ejs", "_version", "version")
    info: dict[str, Any] = {
        "source": "bundled",
        "version": bundled,
        "ejs_version": bundled_ejs,
        "path": None,
        "bundled_version": bundled,
        "bundled_ejs_version": bundled_ejs,
        "fallback": None,
    }
    if any(pkg in sys.modules for pkg in PACKAGES):
        info["fallback"] = "yt-dlp was imported before the update check could run"
        _log.warning("yt-dlp update: %s", info["fallback"])
        return info

    root = plugins_dir()
    for leftover in root.glob(".staging-*"):  # a check cut short by the app closing
        _remove(leftover)
    if not _enabled():
        if any(root.glob("*/" + MANIFEST)):
            _log.info("yt-dlp updates are off; removing the downloaded copies")
            for _, set_dir in _installed_sets(root):
                _remove(set_dir)
        return info

    bundled_key = version_key(bundled)
    sets = _installed_sets(root)
    for index, (key, set_dir) in enumerate(sets):
        if index > 0 or (bundled_key is not None and key <= bundled_key):
            _remove(set_dir)  # older than the newest set, or no newer than the bundled copy
            continue
        verified = False
        try:
            manifest = _load_manifest(set_dir)
            verified = True
            _import_set(set_dir, manifest)
        except Exception as exc:  # noqa: BLE001 - any failure falls back to the bundled copy
            reason = f"{type(exc).__name__}: {exc}"
            _log.error(
                "yt-dlp update %s failed its check (%s); using the bundled %s",
                set_dir.name,
                reason,
                bundled,
            )
            info["fallback"] = f"The downloaded yt-dlp {set_dir.name} failed to load: {reason}"
            # Damaged files are downloaded again; a release that fails to import is skipped.
            if verified:
                _mark_bad(root, set_dir.name)
            _remove(set_dir)
            continue
        info.update(
            source="updated",
            version=manifest["yt_dlp"],
            ejs_version=manifest["yt_dlp_ejs"],
            path=str(set_dir),
        )
        _log.info("using the downloaded yt-dlp %s (bundled: %s)", manifest["yt_dlp"], bundled)
    return info


def activate() -> dict:
    """Make a verified, newer downloaded yt-dlp importable ahead of the bundled one.

    Runs once per process (later calls return the first result) and must run before
    ``yt_dlp`` is imported. Returns the active copy: ``source`` (``bundled`` or
    ``updated``), ``version``, ``ejs_version``, ``path``, the bundled versions, and
    ``fallback`` (why a downloaded copy was not used, else ``None``).
    """
    global _active
    with _ACTIVATE_LOCK:
        if _active is None:
            try:
                _active = _activate()
            except Exception:  # noqa: BLE001 - the bundled copy must always remain usable
                _log.exception("yt-dlp update activation failed")
                _active = {"source": "bundled", "version": None, "fallback": "activation failed"}
        return dict(_active)


def import_yt_dlp():
    """The ``yt_dlp`` module, imported after :func:`activate`."""
    activate()
    import yt_dlp

    return yt_dlp


# -- the check (network) ----------------------------------------------------------------


def _check_url(url: str) -> str:
    """``url`` when it is https on PyPI's default port, else raise."""
    try:
        parts = urlsplit(url)
        ok = parts.scheme == "https" and parts.hostname in _ALLOWED_HOSTS
        ok = ok and parts.port in (None, 443)
    except ValueError:
        ok = False
    if not ok:
        raise YtdlpUpdateError(f"refusing to fetch {url!r}: only https from PyPI is allowed")
    return url


class _PyPIRedirects(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to another allowed PyPI URL."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _check_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _opener() -> urllib.request.OpenerDirector:
    import certifi

    context = ssl.create_default_context(cafile=certifi.where())
    return urllib.request.build_opener(
        urllib.request.HTTPSHandler(context=context), _PyPIRedirects()
    )


def _open(url: str):
    req = urllib.request.Request(
        _check_url(url),
        headers={"User-Agent": f"SawtSakinah/{__version__}", "Accept": "application/json"},
    )
    try:
        return _opener().open(req, timeout=_TIMEOUT)
    except urllib.error.HTTPError as exc:
        raise YtdlpUpdateError(f"PyPI answered {exc.code} for {url}") from exc
    except (urllib.error.URLError, OSError) as exc:
        raise YtdlpUpdateError(f"could not reach PyPI: {exc}") from exc


def _get_json(url: str) -> dict:
    with _open(url) as res:
        body = res.read(_JSON_LIMIT + 1)
    if len(body) > _JSON_LIMIT:
        raise YtdlpUpdateError(f"the PyPI answer for {url} is too large")
    try:
        data = json.loads(body)
    except ValueError as exc:
        raise YtdlpUpdateError(f"PyPI sent invalid JSON for {url}") from exc
    if not isinstance(data, dict):
        raise YtdlpUpdateError(f"unexpected PyPI answer for {url}")
    return data


def _wheel(files: Any, project: str, version: str) -> dict:
    """The release's pure-Python wheel entry (``url``, ``sha256``, ``filename``)."""
    stem = project.replace("-", "_")
    for item in files if isinstance(files, list) else []:
        if not isinstance(item, dict) or item.get("yanked"):
            continue
        name = item.get("filename")
        digest = (item.get("digests") or {}).get("sha256")
        url = item.get("url")
        if (
            item.get("packagetype") == "bdist_wheel"
            and name == f"{stem}-{version}-py3-none-any.whl"
            and isinstance(digest, str)
            and _SHA256.fullmatch(digest)
            and isinstance(url, str)
        ):
            return {"filename": name, "sha256": digest, "url": _check_url(url)}
    raise YtdlpUpdateError(f"PyPI lists no usable wheel for {project} {version}")


def _pick_version(index: dict, channel: str, skip: set[str]) -> str:
    """The newest yt-dlp version on ``channel`` with a usable wheel, not in ``skip``."""
    if channel == "stable":
        version = (index.get("info") or {}).get("version")
        if version_key(version) is None or version in skip:
            raise YtdlpUpdateError(f"PyPI reports no usable stable yt-dlp (got {version!r})")
        return version
    releases = index.get("releases")
    candidates = []
    for version, files in releases.items() if isinstance(releases, dict) else []:
        key = version_key(version)
        if key is None or version in skip:
            continue
        try:
            _wheel(files, "yt-dlp", version)
        except YtdlpUpdateError:
            continue
        candidates.append((key, version))
    if not candidates:
        raise YtdlpUpdateError("PyPI lists no usable yt-dlp release")
    return max(candidates)[1]


def _ejs_pin(release: dict) -> str:
    """The exact yt-dlp-ejs version a yt-dlp release requires (its ``default`` extra)."""
    for requirement in (release.get("info") or {}).get("requires_dist") or []:
        m = _EJS_PIN.fullmatch(requirement.strip()) if isinstance(requirement, str) else None
        if m:
            return m.group(1)
    raise YtdlpUpdateError("the yt-dlp release does not pin a yt-dlp-ejs version")


def _download(wheel: dict, dest: Path, progress: Optional[ProgressFn], label: str) -> Path:
    """Stream ``wheel`` to ``dest`` and check its SHA-256 before anything opens it."""
    path = dest / wheel["filename"]
    digest = hashlib.sha256()
    done = 0
    last = 0.0
    with _open(wheel["url"]) as res, open(path, "wb") as fh:
        total = res.headers.get("Content-Length")
        total = int(total) if total and total.isdigit() else None
        while chunk := res.read(_CHUNK):
            done += len(chunk)
            if done > _WHEEL_LIMIT:
                raise YtdlpUpdateError(f"{wheel['filename']} is larger than expected")
            digest.update(chunk)
            fh.write(chunk)
            now = time.monotonic()
            if progress is not None and now - last > 0.25:
                last = now
                progress(
                    {"stage": "download", "file": label, "bytes_done": done, "bytes_total": total}
                )
    if digest.hexdigest() != wheel["sha256"]:
        raise YtdlpUpdateError(f"{wheel['filename']} does not match PyPI's SHA-256")
    return path


def _unpack(wheel_path: Path, package: str, version: str, dest: Path) -> dict[str, str]:
    """Extract ``package/`` and its ``.dist-info`` from a verified wheel into ``dest``.

    Returns ``{relative path: sha256}`` of the written files. A member with an unsafe
    name, a symlink, or a top-level entry other than those two (or the wheel's ``.data``,
    which is skipped) aborts the unpack.
    """
    dist = f"{package}-{version}"  # the wheel's dist-info stem matches the import name
    allowed = {package, f"{dist}.dist-info"}
    skipped = f"{dist}.data"
    root = dest.resolve()
    files: dict[str, str] = {}
    written = 0
    with zipfile.ZipFile(wheel_path) as zf:
        for info in zf.infolist():
            rel = _safe_member(info.filename)
            if rel is None:
                raise YtdlpUpdateError(f"unsafe file name in {wheel_path.name}: {info.filename!r}")
            if rel.parts[0] == skipped:
                continue
            if rel.parts[0] not in allowed or (len(rel.parts) == 1 and not info.is_dir()):
                raise YtdlpUpdateError(f"unexpected file in {wheel_path.name}: {info.filename!r}")
            if (info.external_attr >> 16) & 0o170000 == 0o120000:
                raise YtdlpUpdateError(f"symlink in {wheel_path.name}: {info.filename!r}")
            target = (dest / rel).resolve()
            if not target.is_relative_to(root):
                raise YtdlpUpdateError(f"{info.filename!r} escapes the plugin folder")
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            key = rel.as_posix()
            if key in files:
                raise YtdlpUpdateError(f"duplicate file in {wheel_path.name}: {key!r}")
            target.parent.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256()
            with zf.open(info) as src, open(target, "xb") as out:
                while chunk := src.read(_CHUNK):
                    written += len(chunk)
                    if written > _UNPACKED_LIMIT:
                        raise YtdlpUpdateError(f"{wheel_path.name} unpacks to too much data")
                    digest.update(chunk)
                    out.write(chunk)
            files[key] = digest.hexdigest()
    if not any(key.startswith(f"{package}/") for key in files):
        raise YtdlpUpdateError(f"{wheel_path.name} holds no {package} package")
    return files


def _due(state: dict, now: float) -> bool:
    interval = CONFIG.app.update_check_interval_hours * 3600.0
    checked = float(state.get("checked_at") or 0)
    failed = float(state.get("failed_at") or -1e18)
    fresh = 0 <= now - checked < interval
    backing_off = 0 <= now - failed < _RETRY_AFTER_FAILURE
    return not fresh and not backing_off


def check_due() -> bool:
    """Whether the launch check should run now (preference on, last check a day ago)."""
    return _enabled() and _due(_state(plugins_dir()), time.time())


def _install_latest(root: Path, progress: Optional[ProgressFn]) -> dict:
    channel = CONFIG.app.ytdlp_channel
    active = activate()
    skip = {v for v in _state(root).get("bad_versions", []) if isinstance(v, str)}
    if progress is not None:
        progress({"stage": "check", "channel": channel})
    version = _pick_version(_get_json(f"{_PYPI}/yt-dlp/json"), channel, skip)

    # Newer than the bundled copy, the one in use and any set already waiting.
    known = [active.get("bundled_version"), active.get("version")]
    known += [set_dir.name for _, set_dir in _installed_sets(root)]
    baseline = max((k for k in map(version_key, known) if k is not None), default=None)
    if baseline is not None and version_key(version) <= baseline:
        return {"status": "up_to_date", "latest": version, "channel": channel}

    release = _get_json(f"{_PYPI}/yt-dlp/{version}/json")
    if (release.get("info") or {}).get("version") != version:
        raise YtdlpUpdateError(f"PyPI answered for a different yt-dlp than {version}")
    ytdlp_wheel = _wheel(release.get("urls"), "yt-dlp", version)
    ejs_version = _ejs_pin(release)
    ejs_wheel = _wheel(
        _get_json(f"{_PYPI}/yt-dlp-ejs/{ejs_version}/json").get("urls"), "yt-dlp-ejs", ejs_version
    )

    staging = root / f".staging-{uuid.uuid4().hex[:12]}"
    tree = staging / "tree"
    try:
        tree.mkdir(parents=True)
        files: dict[str, str] = {}
        for package, wheel, pkg_version in (
            ("yt_dlp", ytdlp_wheel, version),
            ("yt_dlp_ejs", ejs_wheel, ejs_version),
        ):
            path = _download(wheel, staging, progress, PACKAGES[package])
            files.update(_unpack(path, package, pkg_version, tree))
        _write_json(
            tree / MANIFEST,
            {
                "format": _MANIFEST_FORMAT,
                "yt_dlp": version,
                "yt_dlp_ejs": ejs_version,
                "channel": channel,
                "installed_at": datetime.now(timezone.utc).isoformat(),
                "wheels": {w["filename"]: w["sha256"] for w in (ytdlp_wheel, ejs_wheel)},
                "files": files,
            },
        )
        target = root / version
        if target.exists():
            _remove(target)
        tree.rename(target)
    except zipfile.BadZipFile as exc:
        raise YtdlpUpdateError(f"a downloaded wheel is not a valid zip: {exc}") from exc
    finally:
        _remove(staging)
    _log.info(
        "downloaded yt-dlp %s with yt-dlp-ejs %s; used from the next launch", version, ejs_version
    )
    return {
        "status": "installed",
        "latest": version,
        "ejs_version": ejs_version,
        "channel": channel,
    }


def check_and_install(progress: Optional[ProgressFn] = None) -> dict:
    """Download the newest yt-dlp when it is newer than every copy present.

    Returns ``{"status": "installed" | "up_to_date", "latest", ...}``. The new copy is
    used from the next launch. Raises :class:`YtdlpUpdateError` on failure (also
    recorded for :func:`status`), :class:`YtdlpUpdateBusyError` while another check runs.
    """
    if not _CHECK_LOCK.acquire(blocking=False):
        raise YtdlpUpdateBusyError("A yt-dlp update check is already running.")
    try:
        root = plugins_dir()
        root.mkdir(parents=True, exist_ok=True)
        now = time.time()
        try:
            result = _install_latest(root, progress)
        except Exception as exc:
            _log.warning("yt-dlp update check failed: %s", exc)
            _update_state(root, failed_at=now, error=str(exc))
            if isinstance(exc, YtdlpUpdateError):
                raise
            raise YtdlpUpdateError(str(exc)) from exc
        _update_state(root, checked_at=now, failed_at=None, error=None, latest=result["latest"])
        return result
    finally:
        _CHECK_LOCK.release()


def status() -> dict:
    """The active copy plus the update settings and the last check's outcome."""
    active = activate()
    root = plugins_dir()
    state = _state(root)
    sets = _installed_sets(root)
    active_key = version_key(active.get("version"))
    pending = next((d.name for key, d in sets if active_key is None or key > active_key), None)
    checked = state.get("checked_at")
    return {
        "enabled": _enabled(),
        "channel": CONFIG.app.ytdlp_channel,
        "source": active.get("source"),
        "version": active.get("version"),
        "ejs_version": active.get("ejs_version"),
        "bundled_version": active.get("bundled_version"),
        "fallback": active.get("fallback"),
        "pending_version": pending,
        "latest": state.get("latest") if isinstance(state.get("latest"), str) else None,
        "checked_at": (
            datetime.fromtimestamp(float(checked), timezone.utc).isoformat()
            if isinstance(checked, (int, float))
            else None
        ),
        "error": state.get("error") if isinstance(state.get("error"), str) else None,
    }


__all__ = [
    "YtdlpUpdateBusyError",
    "YtdlpUpdateError",
    "activate",
    "import_yt_dlp",
    "check_and_install",
    "check_due",
    "plugins_dir",
    "status",
    "version_key",
]
