"""On-disk project store. Mirrors ``extraction/cache.py`` but for whole ``Project``s.

Each project owns a directory::

    <root>/<project_id>/
      project.json            # {"schema_version": N, **Project.model_dump(mode="json")}
      audio/                  # extracted mp3, 16 kHz working-copy wav, speech map, transcript.json
      exports/<artifact_id>.<ext>
      waveform.json           # cached peaks (lazy)
      playback.mp4            # the mp3's frames in MP4, for exact seeking (lazy)

Writes go through a temp file and an atomic replace so a crash mid-write never leaves a
truncated ``project.json``, and ``update`` holds a per-project lock around the whole
load-modify-save so two concurrent detection jobs cannot clobber each other's results.
``project.json`` carries a ``schema_version``: older files are migrated forward on load
(``models/migrations.py``) and files from a newer app are refused, never rewritten.

Deleting renames the directory to ``.deleting-<id>-<suffix>`` first, then removes it. On
Windows the rename fails while any file inside is open, so a locked project is refused
whole (:class:`ProjectInUseError`) instead of being left half-deleted, and a removal that
fails after the rename only leaves a hidden folder that :meth:`ProjectStore.sweep`
removes at the next start. The store keeps no global state beyond the root it is
constructed with.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import IO, Callable, Iterator, Optional
from uuid import uuid4

from ..fileio import is_partial, remove_tree, replace_file, retry_locked
from ..models import (
    Project,
    ProjectInUseError,
    ProjectSummary,
    ProjectUnreadableError,
)
from ..models.migrations import SCHEMA_VERSION, migrate

_log = logging.getLogger(__name__)

#: Prefix of a project directory that is being (or failed to be) deleted.
TRASH_PREFIX = ".deleting-"
#: Leftovers younger than this are left alone by the sweep: another process sharing the
#: data directory (a dev server beside the desktop app) may still be writing them.
STALE_AFTER_SEC = 600.0
# Rename attempts for a delete: about 1.5 s of retries for streams to let go.
_DELETE_ATTEMPTS = 6
#: Shape of a project id (``uuid4().hex``) or source digest; the routes validate against it
#: too, so a crafted id can never name a path outside the root.
PROJECT_ID = re.compile(r"[0-9a-f]{8,64}")

DAMAGED_MESSAGE = "Its data file is damaged and can't be read."
IN_USE_MESSAGE = "The recording is still in use. Close its playback and try again."


def _now() -> datetime:
    return datetime.now(timezone.utc)


def default_projects_dir() -> Path:
    """Return the default projects root (see :func:`sawt_sakinah.runtime.projects_dir`)."""
    from .. import runtime

    return runtime.projects_dir()


class OpenStreams:
    """File handles that streaming responses hold open, per project.

    A response the client abandoned (the player seeks and starts a new range request) can
    keep its file open until the generator is collected; on Windows that blocks deleting
    the project. :meth:`ProjectStore.delete` closes them first and blocks new ones while it
    runs. A closed handle makes the response's next read raise ``ValueError``, which the
    streaming body treats as the end.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._open: dict[str, set[IO[bytes]]] = {}
        self._blocked: set[str] = set()

    def blocked(self, key: str) -> bool:
        with self._lock:
            return key in self._blocked

    @contextmanager
    def opened(self, key: str, path: str | os.PathLike) -> Iterator[IO[bytes]]:
        """Open ``path`` for reading, tracked under ``key``.

        Raises ``FileNotFoundError`` while ``key`` is blocked.
        """
        if self.blocked(key):
            raise FileNotFoundError(path)
        # Opened outside the lock: a slow open (a scanner) must not stall other streams.
        fh = open(path, "rb")  # noqa: SIM115 - closed below or by close()
        with self._lock:
            if key in self._blocked:  # a delete started meanwhile
                fh.close()
                raise FileNotFoundError(path)
            self._open.setdefault(key, set()).add(fh)
        try:
            yield fh
        finally:
            with self._lock:
                handles = self._open.get(key)
                if handles is not None:
                    handles.discard(fh)
                    if not handles:
                        del self._open[key]
            fh.close()

    def close(self, key: Optional[str] = None) -> int:
        """Close the handles open under ``key`` (every key when ``None``); returns how many."""
        with self._lock:
            keys = [key] if key is not None else list(self._open)
            handles = [fh for k in keys for fh in self._open.pop(k, ())]
        for fh in handles:
            try:
                fh.close()
            except (OSError, ValueError):
                pass
        return len(handles)

    @contextmanager
    def block(self, key: str) -> Iterator[None]:
        """Refuse new handles for ``key`` and close the open ones, for the ``with`` body."""
        with self._lock:
            self._blocked.add(key)
        try:
            self.close(key)
            yield
        finally:
            with self._lock:
                self._blocked.discard(key)


class ProjectStore:
    """Persists ``Project``s as per-project directories under ``root``."""

    def __init__(self, root: str | os.PathLike) -> None:
        self.root = Path(root)
        self.streams = OpenStreams()
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    # -- locking ---------------------------------------------------------------
    def _lock_for(self, project_id: str) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(project_id)
            if lock is None:
                lock = threading.Lock()
                self._locks[project_id] = lock
            return lock

    # -- paths -----------------------------------------------------------------
    def project_dir(self, project_id: str) -> Path:
        return self.root / project_id

    def audio_dir(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "audio"

    def exports_dir(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "exports"

    def waveform_path(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "waveform.json"

    def playback_path(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "playback.mp4"

    def _json_path(self, project_id: str) -> Path:
        return self.project_dir(project_id) / "project.json"

    # -- lifecycle -------------------------------------------------------------
    def prepare(self, project_id: str) -> None:
        """Create the project's directory skeleton (idempotent)."""
        self.audio_dir(project_id).mkdir(parents=True, exist_ok=True)
        self.exports_dir(project_id).mkdir(parents=True, exist_ok=True)

    def exists(self, project_id: str) -> bool:
        return self._json_path(project_id).exists()

    def create(self, project: Project) -> Project:
        self.prepare(project.id)
        self.save(project)
        return project

    @staticmethod
    def _read_raw(path: Path, *, retry: bool = True) -> dict:
        """Parse and migrate ``path``. Raises ``FileNotFoundError`` when it is gone and
        :class:`ProjectUnreadableError` when it can't be used. With ``retry`` a briefly
        locked file is retried; the library listing passes ``False`` so one locked file
        can't stall it."""
        read = lambda: path.read_text(encoding="utf-8")  # noqa: E731
        try:
            text = retry_locked(read) if retry else read()
        except FileNotFoundError:
            raise
        except OSError as exc:
            raise ProjectUnreadableError(
                f"Its data file can't be read ({exc.strerror or exc})."
            ) from exc
        try:
            raw = json.loads(text)
        except ValueError as exc:
            raise ProjectUnreadableError(DAMAGED_MESSAGE) from exc
        return migrate(raw)

    def load(self, project_id: str) -> Optional[Project]:
        """Return the stored ``Project``, or ``None`` when it does not exist.

        References to files that no longer exist on disk are healed: a missing
        ``working_copy``, ``speech_map`` or ``transcript`` is nulled out and export
        artifacts whose files are gone are dropped, so the wire never advertises dangling
        resources.
        Exports saved to a user folder stay listed: the user may have moved them, and
        checking would touch folders (or drives) outside the app on every load.

        Raises:
            ProjectTooNewError: If a newer app version saved the project.
            ProjectUnreadableError: If ``project.json`` is damaged.
        """
        try:
            raw = self._read_raw(self._json_path(project_id))
        except FileNotFoundError:
            return None
        try:
            project = Project.from_dict(raw)
        except ValueError as exc:
            raise ProjectUnreadableError(DAMAGED_MESSAGE) from exc
        return self._heal(project)

    def _heal(self, project: Project) -> Project:
        updates: dict = {}
        src = project.audio_source
        src_updates: dict = {}
        if src.working_copy is not None and not Path(src.working_copy).exists():
            src_updates["working_copy"] = None
        if src.speech_map is not None and not Path(src.speech_map).exists():
            src_updates["speech_map"] = None
        if src.transcript is not None and not Path(src.transcript).exists():
            src_updates["transcript"] = None
        if src_updates:
            updates["audio_source"] = src.model_copy(update=src_updates)
        live = [a for a in project.exports if a.external or Path(a.path).exists()]
        if len(live) != len(project.exports):
            updates["exports"] = live
        return project.model_copy(update=updates) if updates else project

    def save(self, project: Project) -> Path:
        """Atomically persist ``project`` to its ``project.json`` in the current format."""
        self.prepare(project.id)
        path = self._json_path(project.id)
        tmp = path.with_suffix(".json.tmp")
        data = {"schema_version": SCHEMA_VERSION, **project.to_dict()}
        tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
        # Readers (the audio route, the library) open project.json briefly; retry past them.
        replace_file(tmp, path)
        return path

    def update(self, project_id: str, mutator: Callable[[Project], Project]) -> Project:
        """Load, transform via ``mutator``, and save under the per-project lock.

        ``mutator`` receives the freshly loaded project and returns the project to save.
        Because the read-modify-write is serialized per project, two callers updating
        disjoint fields (e.g. silences vs surahs) never lose each other's writes. A project
        that can't be loaded (newer version, damaged) raises and is never written.

        Raises:
            KeyError: If the project does not exist.
            ProjectUnreadableError: If it can't be loaded.
        """
        with self._lock_for(project_id):
            project = self.load(project_id)
            if project is None:
                raise KeyError(project_id)
            updated = mutator(project)
            # ``update`` is the single choke point for every post-creation write (EDL,
            # surahs, silences, exports), so stamping here keeps ``updated_at`` accurate
            # for the library's "recently edited" ordering without touching any route.
            updated = updated.model_copy(update={"updated_at": _now()})
            self.save(updated)
            return updated

    # -- read paths (cheap, no heal) -------------------------------------------
    def audio_path(self, project_id: str) -> Optional[Path]:
        """Resolve the streamable audio file without a full ``load`` + ``_heal``.

        ``GET /audio`` issues many range requests while scrubbing; parsing the whole
        ``project.json`` and stat-ing every export per chunk is wasteful. Read only
        ``audio_source.local_path`` here. Returns ``None`` if the project/sidecar is
        missing or unreadable, or the project is being deleted.
        """
        if self.streams.blocked(project_id):
            return None
        path = self._json_path(project_id)
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return None
        src = raw.get("audio_source") if isinstance(raw, dict) else None
        local = src.get("local_path") if isinstance(src, dict) else None
        return Path(local) if local else None

    def list_summaries(self) -> list[ProjectSummary]:
        """Enumerate completed projects as lightweight summaries, ``updated_at``-desc.

        Reads each ``project.json`` once and projects out only the summary fields -- no
        ``load``/``_heal`` per project. Dirs without a ``project.json`` (mid-extraction)
        and dirs that are not projects (``.deleting-*``) are skipped. A project that can't
        be read is listed with ``unreadable`` set to the reason, so one bad file never
        hides the rest of the library.
        """
        summaries: list[ProjectSummary] = []
        if not self.root.exists():
            return summaries
        for child in self.root.iterdir():
            if not child.is_dir() or not PROJECT_ID.fullmatch(child.name):
                continue
            jpath = child / "project.json"
            if not jpath.exists():
                continue
            try:
                raw = self._read_raw(jpath, retry=False)
                src = raw.get("audio_source") or {}
                summaries.append(
                    ProjectSummary(
                        id=raw["id"],
                        name=raw.get("name") or src.get("title") or "",
                        source_kind=src.get("source_kind") or "youtube",
                        source_url=src.get("source_url"),
                        duration_sec=src.get("duration_sec", 0.0),
                        created_at=raw["created_at"],
                        updated_at=raw["updated_at"],
                        status=raw.get("status") or {},
                        export_count=len(raw.get("exports") or []),
                    )
                )
            except FileNotFoundError:
                continue  # deleted while listing
            except ProjectUnreadableError as exc:
                summaries.append(_unreadable_summary(child, str(exc)))
            except (ValueError, KeyError, TypeError, AttributeError, OSError):
                summaries.append(_unreadable_summary(child, DAMAGED_MESSAGE))
        summaries.sort(key=lambda s: s.updated_at, reverse=True)
        return summaries

    def rename(self, project_id: str, name: str) -> Project:
        """Set the project's library label. Raises ``KeyError`` if it does not exist."""
        return self.update(project_id, lambda p: p.model_copy(update={"name": name}))

    def delete(self, project_id: str) -> bool:
        """Remove the whole project directory. Returns ``False`` if it did not exist.

        The project's open streams are closed and new ones refused, then the directory is
        renamed out of the library and removed. The shared extraction cache is untouched:
        each project owns copies of its audio, so deleting one never strands another.

        Raises:
            ProjectInUseError: If its files stay locked (Windows) through the retries; the
                project is left as it was.
        """
        with self._lock_for(project_id):
            d = self.project_dir(project_id)
            if not d.exists():
                return False
            trash = self.root / f"{TRASH_PREFIX}{project_id}-{uuid4().hex[:8]}"
            with self.streams.block(project_id):
                try:
                    retry_locked(lambda: os.rename(d, trash), attempts=_DELETE_ATTEMPTS)
                except PermissionError as exc:
                    _log.warning("project %s is locked, not deleted: %s", project_id, exc)
                    raise ProjectInUseError(IN_USE_MESSAGE) from exc
        # Drop the lock entry so the map does not grow unbounded across deletes.
        with self._locks_guard:
            self._locks.pop(project_id, None)
        try:
            remove_tree(trash)
        except OSError as exc:
            # Hidden from the library already; the next start's sweep retries.
            _log.warning("could not finish removing %s: %s", trash, exc)
        return True

    def discard_unfinished(self, project_id: str) -> None:
        """Remove the folder of a project whose creating job ended without writing
        ``project.json``; a no-op once it exists. Never raises."""
        if self.exists(project_id):
            return
        try:
            remove_tree(self.project_dir(project_id))
        except OSError as exc:  # a helper may still hold a file; the startup sweep retries
            _log.warning("could not remove the unfinished project %s: %s", project_id, exc)

    # -- startup sweep ----------------------------------------------------------
    def sweep(self, stale_after: float = STALE_AFTER_SEC) -> dict[str, int]:
        """Remove what interrupted work left behind; call before any job runs.

        Removes ``.deleting-*`` directories, project directories that never got a
        ``project.json`` (an import or split that did not finish) and partial files
        (``*.part``, ``*.tmp``) inside projects. Anything modified in the last
        ``stale_after`` seconds is kept. Returns counts per kind.
        """
        counts = {"deleting": 0, "incomplete": 0, "partial": 0}
        if not self.root.is_dir():
            return counts
        cutoff = time.time() - stale_after
        for child in self.root.iterdir():
            try:
                if not child.is_dir():
                    continue
                if child.name.startswith(TRASH_PREFIX):
                    if _newest_mtime(child) < cutoff:
                        shutil.rmtree(child)
                        counts["deleting"] += 1
                elif not PROJECT_ID.fullmatch(child.name):
                    continue
                elif not (child / "project.json").exists():
                    if _newest_mtime(child) < cutoff:
                        shutil.rmtree(child)
                        counts["incomplete"] += 1
                else:
                    counts["partial"] += _remove_partials(child, cutoff)
            except OSError as exc:
                _log.warning("sweep could not clean %s: %s", child, exc)
        if any(counts.values()):
            _log.info("swept leftovers in %s: %s", self.root, counts)
        return counts


def _unreadable_summary(child: Path, reason: str) -> ProjectSummary:
    """A library entry for a project whose ``project.json`` can't be used."""
    try:
        stamp = datetime.fromtimestamp(child.stat().st_mtime, tz=timezone.utc)
    except OSError:
        stamp = _now()
    return ProjectSummary(
        id=child.name,
        name="Unreadable recording",
        source_kind="unknown",
        duration_sec=0.0,
        created_at=stamp,
        updated_at=stamp,
        unreadable=reason,
    )


def _newest_mtime(root: Path) -> float:
    newest = root.stat().st_mtime
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            try:
                newest = max(newest, os.stat(os.path.join(dirpath, name)).st_mtime)
            except OSError:
                pass
    return newest


def _remove_partials(project: Path, cutoff: float) -> int:
    removed = 0
    for dirpath, _dirs, files in os.walk(project):
        for name in files:
            if not is_partial(name):
                continue
            path = Path(dirpath) / name
            try:
                if path.stat().st_mtime < cutoff:
                    path.unlink()
                    removed += 1
            except OSError as exc:
                _log.warning("sweep could not remove %s: %s", path, exc)
    return removed
