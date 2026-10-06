"""The one place the package starts helper programs (ffmpeg, ffprobe).

:func:`run` resolves the program through :mod:`sawt_sakinah.runtime` (bundled absolute path
first), decodes text output as UTF-8 with replacement so Arabic titles and paths can't
crash it under a Windows ANSI code page, never inherits stdin (a windowed build has none),
hides the console window on Windows and applies a timeout.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Optional, Sequence

from .runtime import resolve_executable

# Hides the console window a GUI-subsystem parent would otherwise flash for each child.
_CREATION_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0

#: ffmpeg input options for files the app did not create: read local files only, so a
#: crafted playlist or container can't make ffmpeg open network or other protocols.
INPUT_PROTOCOLS = ("-protocol_whitelist", "file")


def ffmpeg_input(path: str | os.PathLike) -> list[str]:
    """``-protocol_whitelist file -i <path>`` for one ffmpeg input."""
    return [*INPUT_PROTOCOLS, "-i", str(Path(path))]


def run(
    cmd: Sequence[str | os.PathLike],
    *,
    text: bool = True,
    timeout: Optional[float] = None,
    input: Optional[bytes | str] = None,
) -> subprocess.CompletedProcess:
    """Run ``cmd`` to completion and capture its output.

    ``cmd[0]`` is a bare tool name or an absolute path; it is resolved before running.
    Raises :class:`~sawt_sakinah.runtime.ToolNotFoundError` when the program is missing and
    :class:`subprocess.TimeoutExpired` when ``timeout`` (seconds) elapses.
    """
    args = [resolve_executable(cmd[0]), *(os.fspath(a) for a in cmd[1:])]
    kwargs: dict = {
        "capture_output": True,
        "timeout": timeout,
        "creationflags": _CREATION_FLAGS,
    }
    if input is None:
        kwargs["stdin"] = subprocess.DEVNULL
    else:
        kwargs["input"] = input
    if text:
        kwargs.update(text=True, encoding="utf-8", errors="replace")
    return subprocess.run(args, **kwargs)


__all__ = ["INPUT_PROTOCOLS", "ffmpeg_input", "run"]
