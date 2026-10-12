"""Shared route helpers: id-shape validation (path-traversal guard at the URL edge)."""

from __future__ import annotations

from fastapi import HTTPException

from ..projects import PROJECT_ID


def validate_id(value: str, kind: str = "id") -> str:
    """Reject anything but the store's id shape, so a crafted id never names a path
    outside the project root."""
    if not PROJECT_ID.fullmatch(value):
        raise HTTPException(status_code=400, detail=f"invalid {kind}")
    return value
