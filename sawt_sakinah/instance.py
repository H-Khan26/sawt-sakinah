"""One running desktop app per user.

The first instance takes an OS-level lock on ``instance.lock`` in the data directory and,
once its service is up, publishes its port, launch token and process id in
``instance.json``. A second launch fails to take the lock, reads that file and asks the
running instance to bring its window to the front (``POST /app/focus``, authenticated with
the token), then exits.

The OS drops the lock when the owning process dies, so a file left behind by a crash never
blocks the next launch.
"""

from __future__ import annotations

import json
import logging
import os
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
        while True:
            info = self.read_info()
            if info is not None and _request_focus(info):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.25)


def _request_focus(info: dict) -> bool:
    if os.name == "nt" and isinstance(info.get("pid"), int):
        # This process was just launched by the user and may take the foreground; pass
        # that right on so the running instance's window can come to the front.
        try:
            import ctypes

            ctypes.windll.user32.AllowSetForegroundWindow(info["pid"])
        except (OSError, AttributeError):
            pass
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
