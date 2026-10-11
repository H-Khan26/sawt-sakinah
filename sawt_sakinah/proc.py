"""The one place the package starts helper programs (ffmpeg, ffprobe).

:func:`run` resolves the program through :mod:`sawt_sakinah.runtime` (bundled absolute path
first), decodes text output as UTF-8 with replacement so Arabic titles and paths can't
crash it under a Windows ANSI code page, never inherits stdin (a windowed build has none),
hides the console window on Windows and applies a timeout. Running children are tracked so
:func:`terminate_all` can stop them when the app shuts down; a child left running would
otherwise outlive the app (Windows does not end children with their parent) and keep
writing its output.
"""

from __future__ import annotations

import logging
import os
import subprocess
import threading
from pathlib import Path
from typing import Optional, Sequence

from .runtime import resolve_executable

_log = logging.getLogger(__name__)

_LIVE: set[subprocess.Popen] = set()
_LIVE_LOCK = threading.Lock()

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
        "stdin": subprocess.DEVNULL if input is None else subprocess.PIPE,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "creationflags": _CREATION_FLAGS,
    }
    if text:
        kwargs.update(text=True, encoding="utf-8", errors="replace")
    # subprocess.run's own loop, with the child registered while it runs.
    with subprocess.Popen(args, **kwargs) as process:
        with _LIVE_LOCK:
            _LIVE.add(process)
        try:
            stdout, stderr = process.communicate(input, timeout=timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise
        except BaseException:
            process.kill()
            raise
        finally:
            with _LIVE_LOCK:
                _LIVE.discard(process)
        returncode = process.poll()
    return subprocess.CompletedProcess(args, returncode, stdout, stderr)


def terminate_all() -> int:
    """Kill every helper program :func:`run` has running; returns how many.

    The callers see a failed run (non-zero exit) and unwind normally.
    """
    with _LIVE_LOCK:
        live = [p for p in _LIVE if p.poll() is None]
    for process in live:
        try:
            process.kill()
        except OSError:
            pass
    if live:
        _log.info("stopped %d helper program(s)", len(live))
    return len(live)


__all__ = ["INPUT_PROTOCOLS", "ffmpeg_input", "run", "terminate_all"]
