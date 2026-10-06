"""Desktop shell: run the FastAPI service in-process and open it in a native window.

Runs the same app the browser uses (``service.app:create_app``) on a background uvicorn
thread, waits for it to accept connections, then opens a pywebview window pointed at the
local URL. Closing the window stops the server and returns.

Each launch generates a secret token that the service requires on every request; the
window receives it through ``/_session`` (see ``service/security.py``). The default port is
used when free, otherwise the OS picks one.

The SPA must be built first (``cd frontend && npm run build``) so the service can serve it
at ``/`` — the window loads that same origin. Requires the optional ``desktop`` extra
(pywebview) plus the ``service`` extra::

    pip install -e ".[service,desktop]"
    python -m sawt_sakinah.desktop      # or: make desktop

Usage:
    python -m sawt_sakinah.desktop [--host 127.0.0.1] [--port 38427]
"""

from __future__ import annotations

import argparse
import secrets
import socket
import threading
import time
import urllib.error
import urllib.request
from typing import Optional, Sequence


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        try:
            sock.bind((host, port))
        except OSError:
            return False
    return True


def _pick_port(host: str, preferred: int) -> int:
    """``preferred`` when it is free (keeps the SPA's per-origin storage stable), else a
    free port chosen by the OS."""
    if preferred and _port_free(host, preferred):
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((host, 0))
        return sock.getsockname()[1]


def _wait_until_up(base_url: str, headers: dict[str, str], timeout: float = 20.0) -> bool:
    """Poll ``/health`` with the launch token until it answers 200 or ``timeout`` elapses.

    Only this launch's service knows the token, so a 200 rules out another program that
    happens to answer on the same port.
    """
    deadline = time.monotonic() + timeout
    req = urllib.request.Request(f"{base_url}/health", headers=headers)
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(req, timeout=1.0) as res:  # noqa: S310 (local URL)
                if res.status == 200:
                    return True
        except urllib.error.HTTPError:
            return False  # something answered, but it is not this launch's service
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(0.2)
    return False


def run(host: str = "127.0.0.1", port: int = 38427) -> int:
    """Launch the service and the desktop window; block until the window closes."""
    try:
        import uvicorn
    except ImportError:
        raise SystemExit(
            "The desktop shell needs the 'service' extra. Install it with:\n"
            '  pip install -e ".[service,desktop]"'
        )
    try:
        import webview
    except ImportError:
        raise SystemExit(
            "The desktop shell needs the 'desktop' extra (pywebview). Install it with:\n"
            '  pip install -e ".[desktop]"   (or: make requirements-desktop)'
        )

    from .service.app import create_app
    from .service.security import SESSION_PATH, TOKEN_HEADER
    from .service.settings import ServiceSettings

    token = secrets.token_urlsafe(32)
    settings = ServiceSettings(auth_token=token)
    if settings.static_dir is None or not settings.static_dir.is_dir():
        raise SystemExit(
            "The SPA isn't built, so there is nothing to show. Build it first:\n"
            "  cd frontend && npm run build\n"
            "(or set SAWT_STATIC_DIR to a built dist directory)."
        )

    port = _pick_port(host, port)
    app = create_app(settings)
    config = uvicorn.Config(app, host=host, port=port, log_level="warning")
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()

    url = f"http://{host}:{port}"
    if not _wait_until_up(url, {TOKEN_HEADER: token}):
        server.should_exit = True
        raise SystemExit(f"service did not come up at {url}")

    try:
        # The session route sets the token cookie, then redirects to the SPA.
        webview.create_window("Sawt Sakinah", f"{url}{SESSION_PATH}?token={token}")
        webview.start()  # blocks until the window is closed
    finally:
        server.should_exit = True
        thread.join(timeout=5.0)
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Run Sawt Sakinah as a desktop window.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=38427)
    args = parser.parse_args(argv)
    return run(host=args.host, port=args.port)


if __name__ == "__main__":
    raise SystemExit(main())
