"""Small file helpers shared across the package.

Windows refuses to rename, replace or delete a file that another thread or process (a
reader, a media stream, a virus scanner) has open. :func:`retry_locked` retries such a call
briefly, since most of those handles close within milliseconds.

Outputs that take a while to write go to a *partial* name first and are renamed into place
once complete (:func:`part_path`), so leftovers of an interrupted write are recognisable
(:func:`is_partial`) and a startup sweep can remove them without touching finished files.
"""

from __future__ import annotations

import os
import re
import shutil
import time
from pathlib import Path
from typing import Callable, TypeVar

T = TypeVar("T")

_ATTEMPTS = 5
_DELAY = 0.05  # seconds before the first retry; doubles after each one

# ``<name>.part`` / ``<name>.tmp``, optionally followed by the real extension
# (``<id>.part.mp3`` keeps the extension ffmpeg infers the output format from).
_PARTIAL = re.compile(r"\.(?:part|tmp)(?:\.[A-Za-z0-9]{1,8})?$")


def retry_locked(fn: Callable[[], T], *, attempts: int = _ATTEMPTS, delay: float = _DELAY) -> T:
    """Call ``fn``, retrying with doubling delays while it raises ``PermissionError``.

    The last attempt's ``PermissionError`` propagates. With the defaults the retries wait
    about 0.75 s in total.
    """
    for attempt in range(attempts):
        try:
            return fn()
        except PermissionError:
            if attempt == attempts - 1:
                raise
            time.sleep(delay)
            delay *= 2
    raise AssertionError("unreachable")


def replace_file(src: str | os.PathLike, dst: str | os.PathLike) -> None:
    """``os.replace(src, dst)``, retried briefly while the file is locked."""
    retry_locked(lambda: os.replace(src, dst))


def remove_tree(path: str | os.PathLike, *, attempts: int = _ATTEMPTS) -> None:
    """Delete the directory tree at ``path``, retried briefly while files in it are locked.

    A missing tree is not an error. Raises ``PermissionError`` when files stay locked.
    """

    def remove() -> None:
        try:
            shutil.rmtree(path)
        except FileNotFoundError:
            pass

    retry_locked(remove, attempts=attempts)


def part_path(dst: str | os.PathLike) -> Path:
    """The partial name ``dst`` is written under: ``<stem>.part<suffix>``."""
    dst = Path(dst)
    return dst.with_name(f"{dst.stem}.part{dst.suffix}")


def is_partial(name: str) -> bool:
    """Whether ``name`` marks an incomplete write (``*.part``, ``*.part.<ext>``, ``*.tmp``)."""
    return _PARTIAL.search(name) is not None


__all__ = ["retry_locked", "replace_file", "remove_tree", "part_path", "is_partial"]
