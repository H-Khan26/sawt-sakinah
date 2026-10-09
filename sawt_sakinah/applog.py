"""Log file setup for the desktop app.

A windowed (no console) PyInstaller build starts with ``sys.stdout`` and ``sys.stderr``
set to ``None``, so any library that prints -- yt-dlp's ``to_stderr``, tqdm and Hugging
Face progress bars, a thread's uncaught traceback -- would crash on the missing stream.
:func:`setup_logging` replaces a missing stream with one that writes into the log, sends
the ``logging`` root logger to a rotating file in :func:`sawt_sakinah.runtime.logs_dir`,
and records hard crashes (``faulthandler``) next to it.

This module imports nothing from the rest of the package except :mod:`runtime`, so it can
run before the config is loaded.
"""

from __future__ import annotations

import faulthandler
import io
import logging
import os
import subprocess
import sys
import tempfile
import threading
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Optional

from . import runtime

LOG_FILE = "sawt-sakinah.log"
_MAX_BYTES = 2 * 1024 * 1024
_BACKUPS = 3
_FORMAT = "%(asctime)s %(levelname)s %(name)s [%(threadName)s] %(message)s"

_configured: Optional[Path] = None
_crash_file = None  # kept open for faulthandler for the life of the process


class _RotatingHandler(RotatingFileHandler):
    """Rotates like its parent, but keeps logging when the rename fails (Windows refuses
    it while a second app process holds the file open)."""

    def doRollover(self) -> None:
        try:
            super().doRollover()
        except OSError:
            if self.stream is None:
                self.stream = self._open()


class _LogStream(io.TextIOBase):
    """A text stream that forwards each written line to a logger."""

    def __init__(self, logger: logging.Logger, level: int) -> None:
        self._logger = logger
        self._level = level
        self._buffer = ""
        self._lock = threading.Lock()

    @property
    def encoding(self) -> str:  # type: ignore[override]
        return "utf-8"

    def writable(self) -> bool:
        return True

    def isatty(self) -> bool:
        return False

    def write(self, text: str) -> int:
        if not isinstance(text, str):
            text = str(text)
        with self._lock:
            # Progress bars redraw with "\r"; treat it as a line end too.
            self._buffer += text.replace("\r", "\n")
            *lines, self._buffer = self._buffer.split("\n")
        for line in lines:
            if line.strip():
                self._logger.log(self._level, line.rstrip())
        return len(text)

    def flush(self) -> None:
        with self._lock:
            line, self._buffer = self._buffer, ""
        if line.strip():
            self._logger.log(self._level, line.rstrip())


def log_path(filename: str = LOG_FILE) -> Path:
    return runtime.logs_dir() / filename


def setup_logging(filename: str = LOG_FILE, level: int = logging.INFO) -> Path:
    """Send logging (and any missing stdio stream) to ``logs_dir()/filename``; returns the
    log file path. Safe to call more than once: later calls return the first path."""
    global _configured, _crash_file
    if _configured is not None:
        return _configured

    try:
        directory = runtime.logs_dir()
        directory.mkdir(parents=True, exist_ok=True)
    except OSError:
        directory = Path(tempfile.gettempdir())
    path = directory / filename

    root = logging.getLogger()
    root.setLevel(level)
    handler = _RotatingHandler(
        path, maxBytes=_MAX_BYTES, backupCount=_BACKUPS, encoding="utf-8", delay=True
    )
    handler.setFormatter(logging.Formatter(_FORMAT))
    root.addHandler(handler)

    redirected = False
    if sys.stderr is None:
        sys.stderr = _LogStream(logging.getLogger("stderr"), logging.WARNING)
        redirected = True
    else:
        console = logging.StreamHandler(sys.stderr)
        console.setFormatter(logging.Formatter("%(levelname)s %(name)s: %(message)s"))
        root.addHandler(console)
    if sys.stdout is None:
        sys.stdout = _LogStream(logging.getLogger("stdout"), logging.INFO)
        redirected = True
    # Some libraries write to the interpreter's original streams directly.
    if sys.__stdout__ is None:
        sys.__stdout__ = sys.stdout
    if sys.__stderr__ is None:
        sys.__stderr__ = sys.stderr

    if redirected:
        # A failing handler reports to stderr, which is now the log itself.
        logging.raiseExceptions = False
        # Progress bars only add noise to a log file.
        os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
        os.environ.setdefault("TQDM_DISABLE", "1")
        try:
            _crash_file = open(directory / "crash.log", "a", encoding="utf-8")
            faulthandler.enable(file=_crash_file)
        except OSError:
            _crash_file = None

    logging.captureWarnings(True)
    # Per-request access lines would drown everything else.
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    _configured = path
    return path


def open_folder(path: Path) -> None:
    """Show ``path`` in the OS file manager."""
    path.mkdir(parents=True, exist_ok=True)
    if os.name == "nt":
        os.startfile(path)  # type: ignore[attr-defined]  # noqa: S606
        return
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    subprocess.Popen(  # noqa: S603
        [opener, str(path)],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


__all__ = ["LOG_FILE", "log_path", "setup_logging", "open_folder"]
