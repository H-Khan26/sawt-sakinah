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
import threading
from pathlib import Path
from typing import Callable, Optional

from ..models import Project


def default_projects_dir() -> Path:
    """Return the default projects root (``%LOCALAPPDATA%`` on Windows, else XDG-ish)."""
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "youtube_audio_extract" / "projects"
    return Path.home() / ".local" / "share" / "youtube_audio_extract" / "projects"


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
            project = Project.from_dict(json.loads(path.read_text(encoding="utf-8")))
        except (ValueError, OSError):
            return None
        return self._heal(project)

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
            self.save(updated)
            return updated
