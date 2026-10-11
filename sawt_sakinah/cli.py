"""Command-line entry point, installed as the ``sawt`` console script.

Two ways to run the tool locally, mirroring its two usage shapes:

* ``sawt serve``    -- run the FastAPI service (the interactive app the frontend talks
  to: extract -> detect -> edit via EDL -> export). Requires the ``service`` extra.
* ``sawt desktop``  -- the same app in a native window (``--self-test`` runs the headless
  end-to-end check instead). Requires the ``service`` and ``desktop`` extras.
* ``sawt extract``  -- one-shot, no server: a YouTube URL straight to a silence-trimmed
  file via :func:`sawt_sakinah.pipeline.youtube_to_clean_audio`. Exits with
  ``EXIT_BOT_CHECK`` (3) when YouTube refuses the download with its bot check.

Also reachable as ``python -m sawt_sakinah`` (see ``__main__.py``), which is how the
Makefile invokes it so it never depends on the console script being on PATH.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Optional, Sequence

from .config import CONFIG
from .desktop import add_arguments as add_desktop_arguments

# ``sawt extract`` exit code for YouTube's bot check, which CI treats as inconclusive.
EXIT_BOT_CHECK = 3


def _serve(args: argparse.Namespace) -> int:
    """Run the FastAPI service via uvicorn (imported lazily; needs the ``service`` extra)."""
    try:
        import uvicorn
    except ImportError:
        raise SystemExit(
            "The service requires the 'service' extra. Install it with:\n"
            '  pip install -e ".[service]"   (or: make requirements)'
        )
    # A non-loopback bind host must also pass the service's Host check. Set through the
    # environment so the --reload child process inherits it.
    if args.host not in ("127.0.0.1", "localhost") and "SAWT_ALLOWED_HOSTS" not in os.environ:
        os.environ["SAWT_ALLOWED_HOSTS"] = json.dumps(["127.0.0.1", "localhost", args.host])
    # Import string (not the app object) so --reload can re-import on change.
    uvicorn.run(
        "sawt_sakinah.service.app:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )
    return 0


def _desktop(args: argparse.Namespace) -> int:
    """Run the service in-process and open it in a native window (needs the ``desktop``
    extra), or with ``--self-test`` run the headless end-to-end check."""
    from .desktop import launch

    return launch(args)


def _extract(args: argparse.Namespace) -> int:
    """One-shot extract + silence-trim; prints the path of the cleaned file."""
    from .models import YouTubeBotCheckError
    from .pipeline import youtube_to_clean_audio

    try:
        out = youtube_to_clean_audio(
            args.url,
            output_dir=args.output_dir,
            threshold_db=args.threshold_db,
            min_silence_duration=args.min_silence_duration,
            keep_silence=args.keep_silence,
            keep_intermediate=args.keep_intermediate,
        )
    except YouTubeBotCheckError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_BOT_CHECK
    print(out)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sawt", description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the FastAPI service (the interactive app)")
    serve.add_argument("--host", default="127.0.0.1", help="bind host (default: local-only)")
    serve.add_argument("--port", type=int, default=38427, help="bind port (default: 38427)")
    serve.add_argument("--reload", action="store_true", help="autoreload on code change")
    serve.set_defaults(func=_serve)

    desktop = sub.add_parser("desktop", help="run the app in a native window (needs [desktop])")
    add_desktop_arguments(desktop)
    desktop.set_defaults(func=_desktop)

    extract = sub.add_parser("extract", help="one-shot URL -> silence-trimmed file (no server)")
    extract.add_argument("url", help="YouTube video URL or bare 11-char id")
    extract.add_argument("-o", "--output-dir", default=".", help="output directory")
    extract.add_argument("--threshold-db", type=float, default=CONFIG.silence.threshold_db)
    extract.add_argument(
        "--min-silence-duration", type=float, default=CONFIG.silence.min_silence_duration
    )
    extract.add_argument("--keep-silence", type=float, default=CONFIG.silence.keep_silence)
    extract.add_argument(
        "--keep-intermediate",
        action="store_true",
        help="keep the raw extracted file alongside the cleaned one",
    )
    extract.set_defaults(func=_extract)

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)
