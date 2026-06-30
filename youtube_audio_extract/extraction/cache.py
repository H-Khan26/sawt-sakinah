"""On-disk cache for extracted audio, keyed by request id and content hash.

Two lookups, both described in docs/audio/01-extraction.md:

  * by **id** (``sha256(url + format + quality)``) -- lets a resubmitted URL skip the
    download entirely and return the prior :class:`AudioSource`.
  * by **content_hash** -- dedups identical audio reached via different URLs; primarily
    useful for caching downstream detection results.

Storage is a small JSON sidecar per source plus a content-hash index. No eviction
policy yet (clear the directory manually). The cache root is always passed in -- there
is no hidden global state.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from ..models.sources import AudioSource


def default_cache_dir() -> Path:
    """Return the default cache root (``%LOCALAPPDATA%`` on Windows, else ``~/.cache``)."""
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "youtube_audio_extract" / "cache"
    return Path.home() / ".cache" / "youtube_audio_extract"


def _sources_dir(cache_dir: Path) -> Path:
    return Path(cache_dir) / "sources"


def _index_dir(cache_dir: Path) -> Path:
    return Path(cache_dir) / "by_hash"


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
    if source.working_copy is not None and not source.working_copy.exists():
        # The mp3 is still valid; drop the missing working-copy reference.
        return AudioSource.from_dict({**source.to_dict(), "working_copy": None})
    return source


def save(cache_dir: str | os.PathLike, source: AudioSource) -> Path:
    """Persist ``source`` as a JSON sidecar and update the content-hash index."""
    root = Path(cache_dir)
    _sources_dir(root).mkdir(parents=True, exist_ok=True)
    _index_dir(root).mkdir(parents=True, exist_ok=True)

    sidecar = _sidecar_path(root, source.id)
    sidecar.write_text(json.dumps(source.to_dict(), indent=2), encoding="utf-8")

    # content_hash -> id index, for cross-URL dedup / downstream detection caching.
    (_index_dir(root) / f"{source.content_hash}.txt").write_text(
        source.id, encoding="utf-8"
    )
    return sidecar


def find_by_content_hash(
    cache_dir: str | os.PathLike, content_hash: str
) -> Optional[AudioSource]:
    """Return a cached source with the given ``content_hash``, or ``None``."""
    index = _index_dir(Path(cache_dir)) / f"{content_hash}.txt"
    if not index.exists():
        return None
    return load(cache_dir, index.read_text(encoding="utf-8").strip())
