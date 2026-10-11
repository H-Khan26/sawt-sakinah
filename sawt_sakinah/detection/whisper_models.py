"""Whisper model catalog, download and on-disk layout.

The app runs only the CTranslate2 Whisper models listed under ``whisper_models`` in the
config, each pinned to a Hugging Face commit so a re-upload can't change it silently.
A model lives in ``<models_dir>/<id>/`` (default :func:`sawt_sakinah.runtime.models_dir`)
and is loaded from there with ``local_files_only``, so detection never contacts the Hub.

Downloads fetch only the files faster-whisper loads, at the pinned revision, straight into
the model directory. Each file streams into ``<name>.part`` and resumes from its current
size after an interruption (a crash, a closed app, a dropped connection); it is verified
against the repo's hash (SHA-256 for LFS files, the git blob id otherwise) before it is
renamed into place. The directory counts as installed only once ``.complete`` holds the
pinned revision, so a half-finished download is never loaded.

Only the download path imports ``huggingface_hub``; listing and resolving models is
filesystem-only.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional

from .. import runtime
from ..config import CONFIG, WhisperModelConfig

# Files faster-whisper reads from a model directory (as in faster_whisper.utils.download_model).
ALLOW_PATTERNS = (
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
)
# Without these WhisperModel can't load offline (no tokenizer.json means a Hub fetch).
REQUIRED_FILES = ("config.json", "model.bin", "tokenizer.json")

COMPLETE_MARKER = ".complete"
REVISION_FILE = ".revision"
PART_SUFFIX = ".part"

_CHUNK_SIZE = 1 << 20
_PROGRESS_INTERVAL = 0.5  # seconds between progress callbacks
_ATTEMPTS = 5  # per file, resuming from the bytes already written
_TIMEOUT = 30.0  # connect and per-read limit: a stalled stream raises and is retried

ProgressFn = Callable[[dict], None]


class ModelError(Exception):
    """Base for Whisper model management errors."""


class UnknownModelError(ModelError, ValueError):
    """The id is not in the model catalog."""


class ModelNotInstalledError(ModelError):
    """The model is in the catalog but has not been downloaded (or is incomplete)."""


class ModelAlreadyInstalledError(ModelError):
    """A download was requested for a model that is already installed."""


class ModelBusyError(ModelError):
    """The model is downloading or in use, so it can't be changed right now."""


class ModelDownloadError(ModelError):
    """A download failed (network, integrity or disk space)."""


class DownloadCancelledError(ModelDownloadError):
    """The download was cancelled (the app is shutting down); it resumes next time."""


@dataclass(frozen=True)
class _RemoteFile:
    name: str
    size: int
    sha256: Optional[str]  # LFS files
    blob_id: str  # git blob sha1; the content hash for non-LFS files


# Model directories with a download in flight (and its cancel flag) or a detection using them.
_STATE_LOCK = threading.Lock()
_DOWNLOADING: dict[Path, threading.Event] = {}
_IN_USE: dict[Path, int] = {}


# -- catalog ----------------------------------------------------------------------------


def catalog() -> dict[str, WhisperModelConfig]:
    """The supported models, by id, in config order."""
    return dict(CONFIG.whisper_models)


def get_entry(model_id: str) -> WhisperModelConfig:
    entry = CONFIG.whisper_models.get(model_id)
    if entry is None:
        known = ", ".join(CONFIG.whisper_models)
        raise UnknownModelError(f"Unknown Whisper model {model_id!r}; expected one of: {known}")
    return entry


# -- on-disk state ----------------------------------------------------------------------


def model_dir(model_id: str, root: str | os.PathLike | None = None) -> Path:
    """Directory that holds ``model_id`` (whether or not it is installed)."""
    get_entry(model_id)
    base = Path(root) if root is not None else runtime.models_dir()
    return base / model_id


def is_installed(model_id: str, root: str | os.PathLike | None = None) -> bool:
    """True when the model was fully downloaded at the catalog's pinned revision."""
    path = model_dir(model_id, root)
    try:
        marker = (path / COMPLETE_MARKER).read_text(encoding="utf-8").strip()
    except OSError:
        return False
    return marker == get_entry(model_id).revision and all(
        (path / name).is_file() for name in REQUIRED_FILES
    )


def installed_path(model_id: str, root: str | os.PathLike | None = None) -> Path:
    """The installed model's directory; raises :class:`ModelNotInstalledError` otherwise."""
    if not is_installed(model_id, root):
        label = get_entry(model_id).label
        raise ModelNotInstalledError(
            f"The {label} speech model is not downloaded yet. Download it, then try again."
        )
    return model_dir(model_id, root)


def is_downloading(model_id: str, root: str | os.PathLike | None = None) -> bool:
    with _STATE_LOCK:
        return _key(model_dir(model_id, root)) in _DOWNLOADING


def list_models(root: str | os.PathLike | None = None) -> list[dict]:
    """Catalog entries with their install state, in config order."""
    return [
        {
            "id": model_id,
            "label": entry.label,
            "description": entry.description,
            "size_mb": entry.size_mb,
            "installed": is_installed(model_id, root),
        }
        for model_id, entry in CONFIG.whisper_models.items()
    ]


def _key(path: Path) -> Path:
    return Path(os.path.normcase(os.path.abspath(path)))


def acquire(path: str | os.PathLike) -> Callable[[], None]:
    """Mark a model directory as in use, so it can't be deleted until the returned
    release function runs. Releasing more than once has no further effect."""
    key = _key(Path(path))
    with _STATE_LOCK:
        _IN_USE[key] = _IN_USE.get(key, 0) + 1
    released = threading.Event()

    def release() -> None:
        with _STATE_LOCK:
            if released.is_set():
                return
            released.set()
            count = _IN_USE.get(key, 0) - 1
            if count > 0:
                _IN_USE[key] = count
            else:
                _IN_USE.pop(key, None)

    return release


@contextmanager
def in_use(path: str | os.PathLike) -> Iterator[None]:
    """Mark a model directory as in use by a detection, so it can't be deleted meanwhile."""
    release = acquire(path)
    try:
        yield
    finally:
        release()


def delete(
    model_id: str,
    root: str | os.PathLike | None = None,
    on_remove: Optional[Callable[[Path], None]] = None,
) -> Path:
    """Remove the model directory (installed or partial). Returns the removed path.

    ``on_remove`` runs just before the files go (e.g. to drop a cached loaded model).
    Raises :class:`ModelBusyError` while the model is downloading or in use.
    """
    path = model_dir(model_id, root)
    key = _key(path)
    with _STATE_LOCK:
        if key in _DOWNLOADING:
            raise ModelBusyError(f"{get_entry(model_id).label} is downloading.")
        if _IN_USE.get(key):
            raise ModelBusyError(f"{get_entry(model_id).label} is in use by a detection.")
        if on_remove is not None:
            on_remove(path)
        if path.exists():
            shutil.rmtree(path)
    return path


def cancel_downloads() -> None:
    """Ask every running download to stop at its next chunk or retry (partial files are
    kept)."""
    with _STATE_LOCK:
        for event in _DOWNLOADING.values():
            event.set()


# -- download ---------------------------------------------------------------------------


def configure_hf_env() -> None:
    """Keep huggingface_hub from sending telemetry, using a stored token or writing to the
    user's global cache. Takes effect when huggingface_hub is first imported."""
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
    os.environ.setdefault("HF_HOME", str(runtime.cache_dir() / "huggingface"))


class _Progress:
    """Throttled ``{"stage": "downloading", "bytes_done", "bytes_total"}`` reports."""

    def __init__(self, callback: Optional[ProgressFn], total: int) -> None:
        self._callback = callback
        self.total = total
        self.done = 0
        self._last = 0.0

    def add(self, n: int, force: bool = False) -> None:
        self.done += n
        now = time.monotonic()
        if self._callback is not None and (force or now - self._last >= _PROGRESS_INTERVAL):
            self._last = now
            self._callback(
                {"stage": "downloading", "bytes_done": self.done, "bytes_total": self.total}
            )


def _remote_files(entry: WhisperModelConfig) -> list[_RemoteFile]:
    """The needed files at the pinned revision, smallest first."""
    from huggingface_hub import HfApi
    from huggingface_hub.utils import filter_repo_objects

    api = HfApi(token=False)
    tree = [
        f
        for f in api.list_repo_tree(entry.repo, revision=entry.revision)
        if getattr(f, "size", None) is not None
    ]
    wanted = filter_repo_objects(tree, allow_patterns=list(ALLOW_PATTERNS), key=lambda f: f.path)
    files = [
        _RemoteFile(
            name=f.path,
            size=int(f.size),
            sha256=f.lfs.sha256 if f.lfs is not None else None,
            blob_id=f.blob_id,
        )
        for f in wanted
    ]
    missing = [n for n in REQUIRED_FILES if n not in {f.name for f in files}]
    if missing:
        raise ModelDownloadError(f"{entry.repo}@{entry.revision} is missing {missing}")
    return sorted(files, key=lambda f: f.size)


def _prepare_dir(path: Path, revision: str) -> None:
    """Create the model directory, discarding anything left from another revision."""
    rev_file = path / REVISION_FILE
    if path.exists():
        try:
            current = rev_file.read_text(encoding="utf-8").strip()
        except OSError:
            current = None
        if current != revision:
            shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)
    (path / COMPLETE_MARKER).unlink(missing_ok=True)
    rev_file.write_text(revision, encoding="utf-8")


def _new_hasher(f: _RemoteFile):
    if f.sha256 is not None:
        return hashlib.sha256()
    hasher = hashlib.sha1()
    hasher.update(f"blob {f.size}\0".encode())
    return hasher


def _check_space(path: Path, files: list[_RemoteFile]) -> None:
    needed = 0
    for f in files:
        if (path / f.name).is_file():
            continue
        part = path / (f.name + PART_SUFFIX)
        needed += f.size - (part.stat().st_size if part.is_file() else 0)
    free = shutil.disk_usage(path).free
    if needed > free:
        raise ModelDownloadError(
            f"Not enough disk space: the download needs {needed // 1_000_000} MB, "
            f"{free // 1_000_000} MB is free."
        )


def _fetch(
    entry: WhisperModelConfig,
    f: _RemoteFile,
    path: Path,
    progress: _Progress,
    cancel: threading.Event,
) -> None:
    """Download one file into ``path``, resuming its ``.part`` file, then verify and rename."""
    import httpx
    from huggingface_hub import hf_hub_url
    from huggingface_hub.utils import build_hf_headers, get_session

    final = path / f.name
    if final.is_file() and final.stat().st_size == f.size:
        progress.add(f.size)  # verified before it was renamed into place
        return
    part = path / (f.name + PART_SUFFIX)
    hasher = _new_hasher(f)
    offset = 0
    if part.is_file():
        if part.stat().st_size > f.size:
            part.unlink()
        else:
            with part.open("rb") as fh:
                while chunk := fh.read(_CHUNK_SIZE):
                    hasher.update(chunk)
                    offset += len(chunk)
    progress.add(offset)

    url = hf_hub_url(entry.repo, f.name, revision=entry.revision)
    session = get_session()
    last_error: Optional[Exception] = None
    for attempt in range(_ATTEMPTS):
        if offset >= f.size:
            break
        # The backoff wait ends early when the download is cancelled.
        if cancel.is_set() or (attempt and cancel.wait(min(2**attempt, 10))):
            raise DownloadCancelledError("The download was cancelled.")
        headers = build_hf_headers(token=False)
        if offset:
            headers["Range"] = f"bytes={offset}-"
        try:
            with session.stream(
                "GET", url, headers=headers, follow_redirects=True, timeout=_TIMEOUT
            ) as resp:
                if resp.status_code == 200 and offset:
                    # The server ignored the range: start the file over.
                    progress.add(-offset)
                    hasher, offset = _new_hasher(f), 0
                    part.unlink(missing_ok=True)
                elif resp.status_code not in (200, 206):
                    if resp.status_code < 500 and resp.status_code != 429:
                        raise ModelDownloadError(
                            f"Download of {f.name} failed: HTTP {resp.status_code}"
                        )
                    last_error = ModelDownloadError(f"HTTP {resp.status_code}")
                    continue
                with part.open("ab") as fh:
                    for chunk in resp.iter_bytes(_CHUNK_SIZE):
                        if cancel.is_set():
                            raise DownloadCancelledError("The download was cancelled.")
                        fh.write(chunk)
                        hasher.update(chunk)
                        offset += len(chunk)
                        progress.add(len(chunk))
        except httpx.HTTPError as exc:
            last_error = exc

    if offset != f.size:
        raise ModelDownloadError(
            f"Download of {f.name} stopped at {offset} of {f.size} bytes: {last_error}"
        )
    expected = f.sha256 if f.sha256 is not None else f.blob_id
    if hasher.hexdigest() != expected:
        part.unlink(missing_ok=True)
        raise ModelDownloadError(f"{f.name} failed its integrity check; download it again.")
    os.replace(part, final)


def download(
    model_id: str,
    root: str | os.PathLike | None = None,
    progress: Optional[ProgressFn] = None,
) -> Path:
    """Download ``model_id`` at its pinned revision and return its directory.

    Resumes an earlier partial download. Reports ``{"stage": "downloading", "bytes_done",
    "bytes_total"}`` through ``progress``. Raises :class:`ModelBusyError` if the same model
    is already downloading, :class:`DownloadCancelledError` when :func:`cancel_downloads`
    stops it, and :class:`ModelDownloadError` for network, integrity or disk-space failures.
    """
    entry = get_entry(model_id)
    path = model_dir(model_id, root)
    key = _key(path)
    cancel = threading.Event()
    with _STATE_LOCK:
        if key in _DOWNLOADING:
            raise ModelBusyError(f"{entry.label} is already downloading.")
        if _IN_USE.get(key):
            raise ModelBusyError(f"{entry.label} is in use by a detection.")
        _DOWNLOADING[key] = cancel
    try:
        if is_installed(model_id, root):
            return path
        configure_hf_env()
        files = _remote_files(entry)
        _prepare_dir(path, entry.revision)
        _check_space(path, files)
        reporter = _Progress(progress, sum(f.size for f in files))
        reporter.add(0, force=True)
        for f in files:
            _fetch(entry, f, path, reporter, cancel)
        (path / COMPLETE_MARKER).write_text(entry.revision, encoding="utf-8")
        reporter.add(0, force=True)
        return path
    finally:
        with _STATE_LOCK:
            _DOWNLOADING.pop(key, None)


__all__ = [
    "ALLOW_PATTERNS",
    "ModelError",
    "UnknownModelError",
    "ModelNotInstalledError",
    "ModelAlreadyInstalledError",
    "ModelBusyError",
    "ModelDownloadError",
    "DownloadCancelledError",
    "catalog",
    "get_entry",
    "model_dir",
    "is_installed",
    "installed_path",
    "is_downloading",
    "list_models",
    "acquire",
    "in_use",
    "delete",
    "cancel_downloads",
    "configure_hf_env",
    "download",
]
