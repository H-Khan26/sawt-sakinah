"""Run ffmpeg / ffprobe through the shared runner with the configured time limit.

Every ffmpeg and ffprobe call in the package goes through :func:`run_ffmpeg`, which
delegates to :func:`sawt_sakinah.proc.run` (bundled binary first, UTF-8 output, no console
window) and turns a timeout into a plain :class:`RuntimeError` the job layer reports.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Optional, Sequence

from .config import CONFIG
from .proc import run


def run_ffmpeg(
    cmd: Sequence[str | os.PathLike],
    *,
    text: bool = True,
    timeout: Optional[float] = None,
) -> subprocess.CompletedProcess:
    """Run an ffmpeg/ffprobe command and capture its output.

    Args:
        cmd: The command; ``cmd[0]`` is a bare tool name or an absolute path.
        text: Decode output as UTF-8 text; ``False`` returns bytes (e.g. raw PCM).
        timeout: Seconds before the process is stopped. Defaults to
            ``ffmpeg.timeout_sec``.

    Raises:
        ToolNotFoundError: If the program cannot be found.
        RuntimeError: If the process does not finish within ``timeout``.
    """
    limit = CONFIG.ffmpeg.timeout_sec if timeout is None else timeout
    try:
        return run(cmd, text=text, timeout=limit)
    except subprocess.TimeoutExpired as err:
        name = Path(os.fspath(cmd[0])).stem
        raise RuntimeError(
            f"{name} did not finish within {limit:g} seconds and was stopped."
        ) from err


__all__ = ["run_ffmpeg"]
