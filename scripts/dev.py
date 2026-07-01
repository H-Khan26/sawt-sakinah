"""Run the FastAPI backend and the Vite frontend together for local development.

Launched by ``make dev``. Starts uvicorn (with autoreload) and ``npm run dev`` side by
side, streams both to this terminal, and tears both down when either exits or on Ctrl-C.
Cross-platform (Windows/cmd, Git Bash, WSL, macOS, Linux) — hence Python rather than shell
backgrounding, which is not portable.

Usage:
    python scripts/dev.py [--host 127.0.0.1] [--port 8000]
"""

from __future__ import annotations

import argparse
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
IS_WINDOWS = os.name == "nt"


def _npm(sub_args: list[str], *, background: bool) -> subprocess.Popen | subprocess.CompletedProcess:
    """Run ``npm <sub_args>`` in the frontend dir.

    On Windows npm is a ``.cmd`` shim that ``CreateProcess`` cannot launch directly
    (WinError 193), so route through the shell; elsewhere resolve the binary on PATH.
    """
    if IS_WINDOWS:
        cmd: str | list[str] = "npm " + " ".join(sub_args)
        kwargs = {"cwd": FRONTEND, "shell": True}
    else:
        npm_bin = shutil.which("npm")
        if not npm_bin:
            sys.exit("error: 'npm' not found on PATH. Install Node.js/npm to run the frontend.")
        cmd = [npm_bin, *sub_args]
        kwargs = {"cwd": FRONTEND}
    if background:
        return subprocess.Popen(cmd, **kwargs)
    return subprocess.run(cmd, check=True, **kwargs)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run backend + frontend for development.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default="8000")
    args = parser.parse_args()

    if not (FRONTEND / "node_modules").is_dir():
        print("frontend dependencies missing; running 'npm install'...", flush=True)
        _npm(["install"], background=False)

    backend_cmd = [
        sys.executable,
        "-m",
        "sawt_sakinah",
        "serve",
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--reload",
    ]

    print(f"backend:  http://{args.host}:{args.port}", flush=True)
    print("frontend: http://localhost:5173  (proxies /projects,/jobs to the backend)", flush=True)
    print("press Ctrl-C to stop both.\n", flush=True)

    procs: list[subprocess.Popen] = []
    try:
        procs.append(subprocess.Popen(backend_cmd, cwd=ROOT))
        procs.append(_npm(["run", "dev"], background=True))

        # Wait until either process exits, then fall through to teardown.
        while all(p.poll() is None for p in procs):
            time.sleep(0.4)
    except KeyboardInterrupt:
        pass
    finally:
        for p in procs:
            if p.poll() is None:
                p.terminate()
        # Give them a moment to exit cleanly, then force-kill any stragglers.
        deadline = time.time() + 5
        for p in procs:
            remaining = max(0.0, deadline - time.time())
            try:
                p.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                p.kill()

    # Non-zero if a child failed (ignore the Ctrl-C / SIGTERM exit codes).
    clean = {0, -signal.SIGTERM, -signal.SIGINT, signal.SIGTERM, signal.SIGINT}
    return 0 if all((p.returncode or 0) in clean for p in procs) else 1


if __name__ == "__main__":
    raise SystemExit(main())
