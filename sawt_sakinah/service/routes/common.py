"""Shared route helpers: id-shape validation (path-traversal guard at the URL edge)."""

from __future__ import annotations

import re

from fastapi import HTTPException

# ids are uuid4().hex (project) or hex digests (source); reject anything else so a
# crafted id can never escape the project root via the filesystem.
_HEX_ID = re.compile(r"^[0-9a-f]{8,64}$")


def validate_id(value: str, kind: str = "id") -> str:
    if not _HEX_ID.match(value):
        raise HTTPException(status_code=400, detail=f"invalid {kind}")
    return value
