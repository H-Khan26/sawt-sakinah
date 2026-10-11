"""One running desktop app per user.

The first instance takes an OS-level lock on ``instance.lock`` in the data directory and,
once its service is up, publishes its port, launch token and process id in
``instance.json``. A second launch fails to take the lock, reads that file and asks the
running instance to bring its window to the front (``POST /app/focus``, authenticated with
the token), then exits.

On macOS, Finder and the Dock already reopen the running app instead of starting a second
copy; the lock covers launches that bypass them (``open -n``, running the binary directly).

The OS drops the lock when the owning process dies, so a file left behind by a crash never
blocks the next launch.
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import IO, Optional

from . import runtime
from .fileio import replace_file

_log = logging.getLogger(__name__)

FOCUS_PATH = "/app/focus"


def _lock(fh: IO[bytes]) -> None:
    """Take a non-blocking exclusive lock on ``fh``; raises ``OSError`` when it is held."""
    fh.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)


def _unlock(fh: IO[bytes]) -> None:
    fh.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl

        fcntl.flock(fh.fileno(), fcntl.LOCK_UN)


class InstanceLock:
    """The lock file plus the published details of the instance that holds it."""

    def __init__(self, directory: Optional[Path] = None) -> None:
        root = Path(directory) if directory is not None else runtime.data_dir()
        self.lock_path = root / "instance.lock"
        self.info_path = root / "instance.json"
        self._fh: Optional[IO[bytes]] = None

    def acquire(self) -> bool:
        """True when this process now owns the lock."""
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        fh = open(self.lock_path, "a+b")
        try:
            _lock(fh)
        except OSError:
            fh.close()
            return False
        self._fh = fh
        return True

    def publish(self, host: str, port: int, token: str) -> None:
        """Record how a second launch can reach this instance."""
        data = {"host": host, "port": port, "token": token, "pid": os.getpid()}
        tmp = self.info_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        # A second launch may be reading the file at this moment.
        replace_file(tmp, self.info_path)

    def release(self) -> None:
        if self._fh is None:
            return
        try:
            self.info_path.unlink(missing_ok=True)
        except OSError:
            pass
        try:
            _unlock(self._fh)
        except OSError:
            pass
        self._fh.close()
        self._fh = None

    def read_info(self) -> Optional[dict]:
        try:
            data = json.loads(self.info_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict) or not isinstance(data.get("port"), int):
            return None
        if not isinstance(data.get("token"), str):
            return None
        return data

    def focus_running(self, wait: float = 15.0) -> bool:
        """Ask the instance holding the lock to show its window.

        Waits up to ``wait`` seconds for it to publish its details (it may still be
        starting). True when it acknowledged the request.
        """
        deadline = time.monotonic() + wait
        logged = False
        while True:
            info = self.read_info()
            if info is not None and isinstance(info.get("pid"), int):
                # A fresh grant before every attempt: the previous one may have lapsed
                # while a slow request timed out. Only the first refusal is logged.
                problem = _hand_over_foreground(info["pid"])
                if problem and not logged:
                    _log.info("%s", problem)
                    logged = True
            if info is not None and _request_focus(info):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.25)


def _hand_over_foreground(pid: int) -> Optional[str]:
    """Let the running instance (``pid``) come to the front; best effort.

    This process was just launched by the user and may take the foreground, so it passes
    that right on: ``AllowSetForegroundWindow`` on Windows, activating the other app
    through AppKit on macOS. Returns why that did not work, or ``None``.
    """
    try:
        if os.name == "nt":
            import ctypes

            if not ctypes.windll.user32.AllowSetForegroundWindow(pid):
                return f"Windows refused to let process {pid} take the foreground"
        elif sys.platform == "darwin":
            return _activate_mac_app(pid)
    except Exception as exc:  # noqa: BLE001 - focusing is best effort
        return f"could not hand the foreground to process {pid}: {exc}"
    return None


def _activate_mac_app(pid: int) -> Optional[str]:
    """Activate the app with ``pid``, cooperatively on macOS 14 and later.

    macOS 14 only lets the active app hand activation on: this process yields it to the
    target and asks for the target's activation on its own behalf. The running instance
    also activates itself when it handles ``POST /app/focus``. Older systems use the
    plain activation call. Returns why activation failed, or ``None``.
    """
    from AppKit import NSApplication, NSApplicationActivateAllWindows, NSRunningApplication

    target = NSRunningApplication.runningApplicationWithProcessIdentifier_(pid)
    if target is None:
        return f"no running app with process id {pid} to activate"
    if hasattr(target, "activateFromApplication_options_"):
        app = NSApplication.sharedApplication()
        if hasattr(app, "yieldActivationToApplication_"):
            app.yieldActivationToApplication_(target)
        ok = target.activateFromApplication_options_(
            NSRunningApplication.currentApplication(), NSApplicationActivateAllWindows
        )
    else:
        ok = target.activateWithOptions_(NSApplicationActivateAllWindows)
    if not ok:
        return f"macOS declined to activate process {pid} (this launch is not active)"
    return None


def _request_focus(info: dict) -> bool:
    host = info.get("host") or "127.0.0.1"
    req = urllib.request.Request(
        f"http://{host}:{info['port']}{FOCUS_PATH}",
        data=b"",
        method="POST",
        headers={"X-Sawt-Token": info["token"]},
    )
    # Bypass any configured HTTP proxy: the request (and its token) must stay on loopback.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req, timeout=3.0) as res:  # noqa: S310 (local URL)
            return 200 <= res.status < 300
    except (urllib.error.URLError, ConnectionError, OSError) as exc:
        _log.info("running instance did not answer the focus request: %s", exc)
        return False


__all__ = ["FOCUS_PATH", "InstanceLock"]
