"""On-disk cache for extracted audio, keyed by source id (sha256 of url+format+quality).

A resubmitted URL skips the download and returns the prior :class:`AudioSource`. Storage
is a small JSON sidecar per source. No eviction policy (clear the directory manually).
The cache root is always passed in -- there is no hidden global state.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from ..models.sources import AudioSource


def default_cache_dir() -> Path:
    """Return the default cache root (``%LOCALAPPDATA%`` on Windows, else ``~/.cache``)."""
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "sawt_sakinah" / "cache"
    return Path.home() / ".cache" / "sawt_sakinah"


def _sources_dir(cache_dir: Path) -> Path:
    return Path(cache_dir) / "sources"


def _sidecar_path(cache_dir: Path, source_id: str) -> Path:
    return _sources_dir(cache_dir) / f"{source_id}.json"


def load(cache_dir: str | os.PathLike, source_id: str) -> Optional[AudioSource]:
    """Return the cached :class:`AudioSource` for ``source_id``, or ``None`` on miss.

    A sidecar whose referenced artifacts no longer exist on disk is treated as a miss
    so stale entries never return dangling paths.
    """
    sidecar = _sidecar_path(Path(cache_dir), source_id)
    if not sidecar.exists():
        return None
    try:
        source = AudioSource.from_dict(json.loads(sidecar.read_text(encoding="utf-8")))
    except (ValueError, KeyError, OSError):
        return None
    if not source.local_path.exists():
        return None
    # The mp3 is still valid; drop references to derived files that have gone missing.
    healed: dict = {}
    if source.working_copy is not None and not source.working_copy.exists():
        healed["working_copy"] = None
    if source.speech_map is not None and not source.speech_map.exists():
        healed["speech_map"] = None
    if healed:
        return AudioSource.from_dict({**source.to_dict(), **healed})
    return source


def save(cache_dir: str | os.PathLike, source: AudioSource) -> Path:
    """Persist ``source`` as a JSON sidecar."""
    root = Path(cache_dir)
    _sources_dir(root).mkdir(parents=True, exist_ok=True)
    sidecar = _sidecar_path(root, source.id)
    sidecar.write_text(json.dumps(source.to_dict(), indent=2), encoding="utf-8")
    return sidecar
