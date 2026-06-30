"""Content hashing for caching / dedup of extracted audio artifacts."""

from __future__ import annotations

import hashlib
from pathlib import Path

_CHUNK = 1024 * 1024  # 1 MiB


def content_hash(input_path: str | Path) -> str:
    """Return the SHA-256 hex digest of the bytes of ``input_path``.

    Streamed in 1 MiB chunks so large files do not load into memory. Full-file (not
    partial) hashing so two different recitations that share an intro never collide.
    """
    src = Path(input_path)
    h = hashlib.sha256()
    with src.open("rb") as fh:
        for chunk in iter(lambda: fh.read(_CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()
