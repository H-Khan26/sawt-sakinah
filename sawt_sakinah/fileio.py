"""Small file helpers shared across the package."""

from __future__ import annotations

import os
import time

_REPLACE_ATTEMPTS = 5
_REPLACE_DELAY = 0.05  # seconds before the first retry; doubles after each one


def replace_file(src: str | os.PathLike, dst: str | os.PathLike) -> None:
    """``os.replace(src, dst)``, retried briefly while it raises ``PermissionError``.

    Windows refuses to replace a file that another thread or process (a reader, a virus
    scanner) has open; such handles are usually closed within milliseconds.
    """
    delay = _REPLACE_DELAY
    for attempt in range(_REPLACE_ATTEMPTS):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt == _REPLACE_ATTEMPTS - 1:
                raise
            time.sleep(delay)
            delay *= 2


__all__ = ["replace_file"]
