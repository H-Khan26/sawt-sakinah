"""Command-line entry point, installed as the ``sawt`` console script.

Two ways to run the tool locally, mirroring its two usage shapes:

* ``sawt serve``    -- run the FastAPI service (the interactive app the frontend talks
  to: extract -> detect -> edit via EDL -> export). Requires the ``service`` extra.
* ``sawt desktop``  -- the same app in a native window (``--self-test`` runs the headless
  end-to-end check instead). Requires the ``service`` and ``desktop`` extras.
* ``sawt extract``  -- one-shot, no server: a link to a post straight to a silence-trimmed
  file via :func:`sawt_sakinah.pipeline.link_to_clean_audio`. Its exit code says what
  happened (see ``EXIT_CODES``); on a failure it also prints the error type, platform,
  action and yt-dlp version.
* ``sawt platforms`` -- each platform's status against the active yt-dlp, with its canary
  link, as JSON (the link canary in CI reads it).

``SAWT_DATA_DIR`` (an absolute path) moves the app's data, cache and preferences for one
run, e.g. into a scratch folder (see :mod:`sawt_sakinah.runtime`).

Also reachable as ``python -m sawt_sakinah`` (see ``__main__.py``), which is how the
Makefile invokes it so it never depends on the console script being on PATH.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from typing import Optional, Sequence

from . import runtime
from .config import CONFIG
from .desktop import add_arguments as add_desktop_arguments

# ``sawt extract`` exit codes. 2 is argparse's usage error (and a bad SAWT_DATA_DIR).
EXIT_FAILURE = 1
# The site refused this network: a bot check, a sign-in wall or a rate limit. CI treats it
# as inconclusive. EXIT_BOT_CHECK names the same code for YouTube's bot check.
EXIT_BLOCKED = EXIT_BOT_CHECK = 3
# yt-dlp can't handle the site (ExtractorOutdatedError) or can't import from it at all
# (PlatformUnavailableError).
EXIT_OUTDATED = 4
# Not a usable link: invalid, an unsupported site, or not a single post.
EXIT_INPUT = 5

EXIT_CODES = f"""exit codes:
  0  imported
  {EXIT_FAILURE}  any other failure (the post is gone, has no audio, a network error, ...)
  2  usage error, or SAWT_DATA_DIR is not an absolute path
  {EXIT_BLOCKED}  blocked: a bot check, sign-in wall or rate limit (inconclusive)
  {EXIT_OUTDATED}  outdated: yt-dlp can't handle the site, or can't import from it at all
  {EXIT_INPUT}  input: not a link, an unsupported site, or not a single post

Set SAWT_DATA_DIR (an absolute path) to keep the cache, config and preferences in a
scratch folder."""


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


def exit_code(err: Exception) -> int:
    """The ``sawt extract`` exit code for a failed import."""
    from .models import errors

    if isinstance(
        err, (errors.YouTubeBotCheckError, errors.LoginRequiredError, errors.RateLimitedError)
    ):
        return EXIT_BLOCKED
    if isinstance(err, (errors.ExtractorOutdatedError, errors.PlatformUnavailableError)):
        return EXIT_OUTDATED
    if isinstance(err, errors.InvalidInputError):
        return EXIT_INPUT
    return EXIT_FAILURE


def _extract(args: argparse.Namespace) -> int:
    """One-shot extract + silence-trim; prints the path of the cleaned file."""
    from .extraction import compat
    from .models import ExtractionError
    from .pipeline import link_to_clean_audio

    # The extraction's log lines (capabilities, warnings, the failure line) go to stderr.
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    try:
        out = link_to_clean_audio(
            args.url,
            output_dir=args.output_dir,
            threshold_db=args.threshold_db,
            min_silence_duration=args.min_silence_duration,
            keep_silence=args.keep_silence,
            keep_intermediate=args.keep_intermediate,
        )
    except ExtractionError as exc:
        code = exit_code(exc)
        print(f"error: {exc}", file=sys.stderr)
        print(
            f"error_type={type(exc).__name__} platform={exc.platform} action={exc.action} "
            f"yt-dlp={compat.ytdlp_label()} exit_code={code}",
            file=sys.stderr,
        )
        return code
    print(out)
    return 0


def _platforms(args: argparse.Namespace) -> int:
    """Print each platform's status against the active yt-dlp as JSON."""
    from . import ytdlp_updates
    from .extraction import compat
    from .extraction.platforms import PLATFORMS

    statuses = [compat.platform_status(p) for p in PLATFORMS]
    report = {
        "ytdlp": {"version": compat.ytdlp_version(), "source": compat.ytdlp_source()},
        "curl_cffi": ytdlp_updates.curl_cffi_version(),
        "capabilities": sorted(compat.capabilities()),
        "platforms": [
            {
                "id": p.id,
                "label": p.label,
                "available": s.available,
                "limited": s.limited,
                "reason": s.reason,
                "canary_url": p.canary_url,
            }
            for p, s in zip(PLATFORMS, statuses)
        ],
    }
    print(json.dumps(report, indent=2))
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

    extract = sub.add_parser(
        "extract",
        help="one-shot URL -> silence-trimmed file (no server)",
        epilog=EXIT_CODES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    extract.add_argument(
        "url", help="link to a YouTube, Instagram, X or Facebook post (or a YouTube video id)"
    )
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

    platforms = sub.add_parser(
        "platforms", help="print each platform's status and canary link as JSON"
    )
    platforms.set_defaults(func=_platforms)

    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    # The desktop command reports this itself, in its log and (frozen) a message box.
    data_dir_error = runtime.data_dir_env_error()
    if data_dir_error is not None and args.command != "desktop":
        print(f"error: {data_dir_error}", file=sys.stderr)
        return 2
    return args.func(args)
