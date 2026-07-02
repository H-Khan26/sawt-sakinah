"""On-disk project store. Mirrors ``extraction/cache.py`` but for whole ``Project``s.

Each project owns a directory::

    <root>/<project_id>/
      project.json            # Project.model_dump(mode="json")
      audio/                  # extracted mp3 + 16 kHz working-copy wav
      exports/<artifact_id>.<ext>
      waveform.json           # cached peaks (lazy)

Writes go through ``os.replace`` after a temp write so a crash mid-write never leaves a
truncated ``project.json``, and ``update`` holds a per-project lock around the whole
load-modify-save so two concurrent detection jobs cannot clobber each other's results.
The store keeps no global state beyond the root it is constructed with.
"""

from __future__ import annotations

import json
import os
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

from ..models import Project, ProjectSummary


def _now() -> datetime:
    return datetime.now(timezone.utc)


def default_projects_dir() -> Path:
    """Return the default projects root (``%LOCALAPPDATA%`` on Windows, else XDG-ish)."""
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "sawt_sakinah" / "projects"
    return Path.home() / ".local" / "share" / "sawt_sakinah" / "projects"


class ProjectStore:
    """Persists ``Project``s as per-project directories under ``root``."""

    def __init__(self, root: str | os.PathLike) -> None:
        self.root = Path(root)
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

    def load(self, project_id: str) -> Optional[Project]:
        """Return the stored ``Project``, or ``None`` on miss / unreadable sidecar.

        References to files that no longer exist on disk are healed: a missing
        ``working_copy`` is nulled out and export artifacts whose files are gone are
        dropped, so the wire never advertises dangling resources.
        """
        path = self._json_path(project_id)
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return None
        try:
            project = Project.from_dict(self._backfill(raw))
        except ValueError:
            return None
        return self._heal(project)

    @staticmethod
    def _backfill(raw: dict) -> dict:
        """Fill identity/timestamp fields absent from ``project.json`` files that predate
        them, so old projects load with semantically correct values (the next ``save``
        persists them). Mirrors the "heal on read" tolerance used for dangling files.
        """
        src = raw.get("audio_source") or {}
        src_created = src.get("created_at")
        if not raw.get("name"):
            raw["name"] = src.get("title") or ""
        if not raw.get("created_at") and src_created:
            raw["created_at"] = src_created
        if not raw.get("updated_at"):
            raw["updated_at"] = raw.get("created_at") or src_created
        return raw

    def _heal(self, project: Project) -> Project:
        updates: dict = {}
        src = project.audio_source
        if src.working_copy is not None and not Path(src.working_copy).exists():
            updates["audio_source"] = src.model_copy(update={"working_copy": None})
        live = [a for a in project.exports if Path(a.path).exists()]
        if len(live) != len(project.exports):
            updates["exports"] = live
        return project.model_copy(update=updates) if updates else project

    def save(self, project: Project) -> Path:
        """Atomically persist ``project`` to its ``project.json``."""
        self.prepare(project.id)
        path = self._json_path(project.id)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(project.to_dict(), indent=2), encoding="utf-8")
        os.replace(tmp, path)
        return path

    def update(self, project_id: str, mutator: Callable[[Project], Project]) -> Project:
        """Load, transform via ``mutator``, and save under the per-project lock.

        ``mutator`` receives the freshly loaded project and returns the project to save.
        Because the read-modify-write is serialized per project, two callers updating
        disjoint fields (e.g. silences vs markers) never lose each other's writes.

        Raises:
            KeyError: If the project does not exist.
        """
        with self._lock_for(project_id):
            project = self.load(project_id)
            if project is None:
                raise KeyError(project_id)
            updated = mutator(project)
            # ``update`` is the single choke point for every post-creation write (EDL,
            # markers, silences, exports), so stamping here keeps ``updated_at`` accurate
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
        missing or unreadable.
        """
        path = self._json_path(project_id)
        if not path.exists():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return None
        local = (raw.get("audio_source") or {}).get("local_path")
        return Path(local) if local else None

    def list_summaries(self) -> list[ProjectSummary]:
        """Enumerate completed projects as lightweight summaries, ``updated_at``-desc.

        Reads each ``project.json`` once and projects out only the summary fields -- no
        ``load``/``_heal`` per project. Dirs without a ``project.json`` (mid-extraction)
        and corrupt sidecars are skipped, same tolerance as ``load``.
        """
        summaries: list[ProjectSummary] = []
        if not self.root.exists():
            return summaries
        for child in self.root.iterdir():
            if not child.is_dir():
                continue
            jpath = child / "project.json"
            if not jpath.exists():
                continue
            try:
                raw = self._backfill(json.loads(jpath.read_text(encoding="utf-8")))
                src = raw.get("audio_source") or {}
                summaries.append(
                    ProjectSummary(
                        id=raw["id"],
                        name=raw.get("name") or src.get("title") or "",
                        source_url=src.get("source_url", ""),
                        duration_sec=src.get("duration_sec", 0.0),
                        created_at=raw["created_at"],
                        updated_at=raw["updated_at"],
                        status=raw.get("status") or {},
                        export_count=len(raw.get("exports") or []),
                    )
                )
            except (ValueError, KeyError, TypeError, OSError):
                continue
        summaries.sort(key=lambda s: s.updated_at, reverse=True)
        return summaries

    def rename(self, project_id: str, name: str) -> Project:
        """Set the project's library label. Raises ``KeyError`` if it does not exist."""
        return self.update(project_id, lambda p: p.model_copy(update={"name": name}))

    def delete(self, project_id: str) -> bool:
        """Remove the whole project directory. Returns ``False`` if it did not exist.

        The shared extraction cache is untouched: each project owns copies of its audio,
        so deleting one never strands another.
        """
        with self._lock_for(project_id):
            d = self.project_dir(project_id)
            if not d.exists():
                return False
            shutil.rmtree(d)
        # Drop the lock entry so the map does not grow unbounded across deletes.
        with self._locks_guard:
            self._locks.pop(project_id, None)
        return True
