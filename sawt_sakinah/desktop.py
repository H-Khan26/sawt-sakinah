"""Desktop shell: run the FastAPI service in-process and open it in a native window.

:func:`main` is the desktop app's entry point (the frozen bundle calls it directly). It:

1. calls ``multiprocessing.freeze_support()`` and sends logging, and any missing stdio
   stream of a windowed build, to a rotating log file (``applog``);
2. lets only one instance run: a second launch brings the running window to the front
   and exits (``instance``);
3. checks for the Microsoft Edge WebView2 runtime on Windows and explains how to get it
   when it is missing;
4. starts the service on a free localhost port with a per-launch secret token, waits for
   ``/health`` to answer with that token, then opens a pywebview window that receives the
   token through ``/_session`` (see ``service/security.py``). Closing the window stops the
   server and ends the process, even while a job is still running.

A fatal startup error is logged and, in the bundle, shown in a message box instead of the
app silently vanishing. ``--self-test`` runs the headless end-to-end check in
``selftest.py`` instead of opening a window. ``SAWT_DATA_DIR`` moves every per-user file
(data, logs, config) for the run (see :mod:`sawt_sakinah.runtime`).

In a source checkout the SPA must be built first (``cd frontend && npm run build``) so the
service can serve it at ``/``. Requires the ``service`` and ``desktop`` extras::

    pip install -e ".[service,desktop]"
    python -m sawt_sakinah desktop      # or: make desktop

Usage:
    python -m sawt_sakinah.desktop [--host 127.0.0.1] [--port N]
                                   [--self-test] [--self-test-report PATH]
"""

from __future__ import annotations

import argparse
import logging
import multiprocessing
import os
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, NoReturn, Optional, Sequence

from . import runtime

_log = logging.getLogger("sawt_sakinah.desktop")

APP_TITLE = "Sawt Sakinah"
WEBVIEW2_URL = "https://developer.microsoft.com/microsoft-edge/webview2/"
_WEBVIEW2_CLIENT = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

# MessageBoxW flags and results.
_MB_OK = 0x0
_MB_YESNO = 0x4
_MB_ICONERROR = 0x10
_MB_ICONWARNING = 0x30
_MB_SETFOREGROUND = 0x10000
_IDYES = 6


class StartupError(Exception):
    """A startup failure with a message meant for the user.

    ``url``, when set, is offered to the user (e.g. a download page).
    """

    def __init__(self, message: str, url: Optional[str] = None) -> None:
        super().__init__(message)
        self.url = url


# -- port and service ---------------------------------------------------------------------


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        # Match uvicorn's bind on POSIX so a previous run's TIME_WAIT sockets don't count
        # as busy. On Windows SO_REUSEADDR would allow binding over a live listener.
        if os.name != "nt":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def pick_port(host: str, port: Optional[int] = None) -> int:
    """``port`` when given (it must be free), else a free port chosen by the OS.

    The app keeps no state in the window's origin (preferences live server-side), so a
    new random port each launch costs nothing.
    """
    if port:
        if not _port_free(host, port):
            raise StartupError(f"Port {port} on {host} is already in use.")
        return port
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return sock.getsockname()[1]


def _wait_until_up(base_url: str, headers: dict[str, str], timeout: float = 30.0) -> bool:
    """Poll ``/health`` with the launch token until it answers 200 or ``timeout`` elapses.

    Only this launch's service knows the token, so a 200 rules out another program that
    happens to answer on the same port.
    """
    deadline = time.monotonic() + timeout
    req = urllib.request.Request(f"{base_url}/health", headers=headers)
    # Bypass any configured HTTP proxy: the probe (and its token) must stay on loopback.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    while time.monotonic() < deadline:
        try:
            with opener.open(req, timeout=1.0) as res:  # noqa: S310 (local URL)
                if res.status == 200:
                    return True
        except urllib.error.HTTPError:
            return False  # something answered, but it is not this launch's service
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(0.1)
    return False


class Service:
    """The FastAPI app running on a background uvicorn thread."""

    def __init__(self, settings: Any, host: str, port: int) -> None:
        import uvicorn

        from .service.app import create_app

        if host not in settings.allowed_hosts:
            settings.allowed_hosts.append(host)
        self.host = host
        self.port = port
        self.token: str = settings.auth_token
        self.url = f"http://{host}:{port}"
        self.app = create_app(settings)
        # log_config=None: uvicorn's records go through the root logger (the log file)
        # instead of uvicorn reconfiguring logging around stdout.
        config = uvicorn.Config(
            self.app,
            host=host,
            port=port,
            log_config=None,
            log_level="info",
            access_log=False,
        )
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=self.server.run, name="uvicorn", daemon=True)

    def start(self, timeout: float = 30.0) -> None:
        from .service.security import TOKEN_HEADER

        self.thread.start()
        if not _wait_until_up(self.url, {TOKEN_HEADER: self.token}, timeout):
            self.stop()
            raise StartupError(f"The app's background service did not start at {self.url}.")
        _log.info("service up at %s", self.url)

    def stop(self) -> None:
        self.server.should_exit = True
        if self.thread.is_alive():
            self.thread.join(timeout=5.0)


def new_token() -> str:
    return secrets.token_urlsafe(32)


# -- native UI helpers --------------------------------------------------------------------


def _mac_alert(text: str, *, error: bool, ask: bool) -> bool:
    """Show an alert through ``osascript``; True when the user chose Yes.

    The text travels as an argument, so it needs no AppleScript quoting.
    """
    import subprocess

    buttons = '{"No", "Yes"} default button "Yes"' if ask else '{"OK"} default button "OK"'
    script = [
        "on run argv",
        "display alert (item 1 of argv) message (item 2 of argv) "
        f"as {'critical' if error else 'warning'} buttons {buttons}",
        "return button returned of result",
        "end run",
    ]
    args = ["/usr/bin/osascript"]
    for line in script:
        args += ["-e", line]
    try:
        res = subprocess.run(  # noqa: S603
            [*args, APP_TITLE, text],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdin=subprocess.DEVNULL,
            timeout=600,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return res.stdout.strip() == "Yes"


def message_box(text: str, *, error: bool = True, ask: bool = False) -> bool:
    """Show a native message box (Windows, macOS); True when the user answered Yes.

    Elsewhere, and when no box can be shown, the text goes to the log only.
    """
    _log.log(logging.ERROR if error else logging.WARNING, "%s", text)
    if sys.platform == "darwin":
        return _mac_alert(text, error=error, ask=ask)
    if os.name != "nt":
        return False
    try:
        import ctypes

        flags = (_MB_ICONERROR if error else _MB_ICONWARNING) | _MB_SETFOREGROUND
        flags |= _MB_YESNO if ask else _MB_OK
        return ctypes.windll.user32.MessageBoxW(None, text, APP_TITLE, flags) == _IDYES
    except (OSError, AttributeError):
        return False


def _open_url(url: str) -> None:
    import webbrowser

    try:
        webbrowser.open(url)
    except Exception:  # noqa: BLE001 - best effort
        _log.exception("could not open %s", url)


def webview2_installed() -> bool:
    """Whether the Microsoft Edge WebView2 runtime is registered (Windows only)."""
    import winreg

    client = rf"Microsoft\EdgeUpdate\Clients\{_WEBVIEW2_CLIENT}"
    keys = [
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\{client}"),
        (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\{client}"),
        (winreg.HKEY_CURRENT_USER, rf"SOFTWARE\{client}"),
    ]
    for hive, path in keys:
        try:
            with winreg.OpenKey(hive, path) as key:
                version, _ = winreg.QueryValueEx(key, "pv")
        except OSError:
            continue
        if isinstance(version, str) and version.strip() not in ("", "0.0.0.0"):
            return True
    return False


def _require_webview2() -> None:
    if os.name == "nt" and not webview2_installed():
        raise StartupError(
            "Sawt Sakinah needs the Microsoft Edge WebView2 Runtime, which isn't installed "
            "on this computer. It is a free download from Microsoft:\n\n"
            f"{WEBVIEW2_URL}\n\nOpen the download page now?",
            url=WEBVIEW2_URL,
        )


class _WindowFocus:
    """Brings the pywebview window to the front; called from ``POST /app/focus``."""

    def __init__(self, window: Any) -> None:
        self.window = window
        self.minimized = False
        window.events.minimized += self._on_minimized
        window.events.restored += self._on_restored
        window.events.maximized += self._on_restored

    def _on_minimized(self) -> None:
        self.minimized = True

    def _on_restored(self) -> None:
        self.minimized = False

    def __call__(self) -> None:
        try:
            if self.minimized:
                self.window.restore()
                self.minimized = False
            self.window.show()
            # Briefly pinning the window on top raises it even when the OS refuses to
            # hand the foreground to a background process.
            self.window.on_top = True
            self.window.on_top = False
        except Exception:  # noqa: BLE001 - focusing is best effort
            _log.exception("could not focus the window")


# -- the app ------------------------------------------------------------------------------


def _import_runtime_deps() -> None:
    try:
        import uvicorn  # noqa: F401
    except ImportError:
        raise StartupError(
            "The app is incomplete (the web service is missing). Download it again."
            if runtime.FROZEN
            else "The desktop shell needs the 'service' extra. Install it with:\n"
            '  pip install -e ".[service,desktop]"'
        )
    try:
        import webview  # noqa: F401
    except ImportError:
        raise StartupError(
            "The app is incomplete (the window component is missing). Download it again."
            if runtime.FROZEN
            else "The desktop shell needs the 'desktop' extra (pywebview). Install it with:\n"
            '  pip install -e ".[desktop]"   (or: make requirements-desktop)'
        )


def run(host: str = "127.0.0.1", port: Optional[int] = None) -> int:
    """Launch the service and the desktop window; block until the window closes."""
    from .instance import InstanceLock

    _import_runtime_deps()

    lock = InstanceLock()
    if not lock.acquire():
        _log.info("already running; asking the running instance to show its window")
        if not lock.focus_running():
            _log.warning("the running instance did not respond")
        return 0

    try:
        _require_webview2()

        import webview

        from .service.security import SESSION_PATH
        from .service.settings import ServiceSettings

        settings = ServiceSettings(auth_token=new_token())
        if settings.static_dir is None or not settings.static_dir.is_dir():
            raise StartupError(
                "The app is incomplete (its interface files are missing). Download it again "
                "and replace the whole folder."
                if runtime.FROZEN
                else "The SPA isn't built, so there is nothing to show. Build it first:\n"
                "  cd frontend && npm run build\n"
                "(or set SAWT_STATIC_DIR to a built dist directory)."
            )

        service = Service(settings, host, pick_port(host, port))
        service.start()
        try:
            lock.publish(host, service.port, service.token)
            # The session route sets the token cookie, then redirects to the SPA.
            window = webview.create_window(
                APP_TITLE,
                f"{service.url}{SESSION_PATH}?token={service.token}",
                width=1280,
                height=860,
                min_size=(900, 600),
            )
            service.app.state.focus_window = _WindowFocus(window)
            storage = runtime.data_dir() / "webview"
            storage.mkdir(parents=True, exist_ok=True)
            # Private mode keeps no cookies between launches and deletes the engine's
            # working folder on close; the storage path puts that folder in a dedicated
            # spot under the data directory, out of the (read-only) app folder.
            webview.start(private_mode=True, storage_path=str(storage))
        finally:
            service.app.state.focus_window = None
            service.stop()
    finally:
        lock.release()
    return 0


def _report_user_config(show_box: bool) -> None:
    """Tell the user when their ``config.yaml`` was ignored (it had an error)."""
    from . import config

    if not config.USER_CONFIG_ERROR:
        return
    text = f"{config.USER_CONFIG_ERROR}\n\nSawt Sakinah is using its default settings instead."
    if show_box:
        message_box(text, error=False)
    else:
        _log.warning("%s", text)


def add_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--host", default="127.0.0.1", help="bind host (default: local-only)")
    parser.add_argument(
        "--port", type=int, default=None, help="bind port (default: a free port per launch)"
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run the headless end-to-end check instead of opening a window",
    )
    parser.add_argument(
        "--self-test-report",
        metavar="PATH",
        default=None,
        help="also write the self-test result as JSON to PATH",
    )


def _exit_process(code: int) -> NoReturn:
    """End the process now with ``code``, after flushing stdio and the log.

    A job still running when the window closes (a Whisper transcription can't be
    interrupted) would otherwise keep a windowless process alive, running beside the next
    launch. Helper subprocesses end on their own timeouts.
    """
    _log.info("Sawt Sakinah exiting (code %s)", code)
    for stream in (sys.stdout, sys.stderr):
        try:
            if stream is not None:
                stream.flush()
        except (OSError, ValueError):
            pass
    logging.shutdown()
    os._exit(code)


def launch(args: argparse.Namespace) -> int:
    """Set up logging, then run the app (or the self-test) with user-facing error handling.

    The window path ends the process when the app is done instead of returning; the
    self-test returns its exit code.
    """
    from .applog import LOG_FILE, setup_logging

    self_test = bool(getattr(args, "self_test", False))
    log_file = setup_logging("self-test.log" if self_test else LOG_FILE)
    # Never block an unattended self-test on a modal box.
    show_boxes = runtime.FROZEN and not self_test
    _log.info(
        "Sawt Sakinah starting (frozen=%s, python=%s, log=%s)",
        runtime.FROZEN,
        sys.version.split()[0],
        log_file,
    )
    code = _launch(args, self_test, show_boxes, log_file)
    if not self_test:
        _exit_process(code)
    return code


def _launch(args: argparse.Namespace, self_test: bool, show_boxes: bool, log_file: Path) -> int:
    try:
        data_dir_error = runtime.data_dir_env_error()
        if data_dir_error is not None:
            raise StartupError(data_dir_error)
        _report_user_config(show_boxes)
        if self_test:
            from .selftest import run_self_test

            return run_self_test(host=args.host, report_path=args.self_test_report)
        return run(host=args.host, port=args.port)
    except StartupError as exc:
        _log.error("startup failed: %s", exc)
        if show_boxes:
            if message_box(str(exc), ask=exc.url is not None) and exc.url:
                _open_url(exc.url)
        else:
            print(str(exc), file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001 - last line of defence for a windowed app
        _log.exception("fatal error")
        if show_boxes:
            message_box(
                f"Sawt Sakinah stopped because of an unexpected error:\n\n{exc}\n\n"
                f"Details are in the log file:\n{log_file}"
            )
        else:
            raise
        return 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    multiprocessing.freeze_support()
    parser = argparse.ArgumentParser(description="Run Sawt Sakinah as a desktop window.")
    add_arguments(parser)
    args = parser.parse_args(argv)
    return launch(args)


if __name__ == "__main__":
    raise SystemExit(main())
