"""Compare the helper programs pinned in ``binaries.json`` with the newest upstream releases.

Dependabot cannot track ffmpeg and Deno, so the weekly ``upstream-check`` workflow runs
this script and keeps a tracking issue open while any pin is behind. Sources:

- Deno: the latest denoland/deno GitHub release.
- FFmpeg for Windows (BtbN): the newest release-branch LGPL build in BtbN's ``latest``
  release, compared by FFmpeg version (``n8.1.3-9-g...`` counts as 8.1.3).
- FFmpeg for macOS (Martin Riedl): the version in the URL that the provider's
  ``latest release`` redirect points to.

Writes a Markdown report to ``--report`` and prints it. Exit code 1 when any pin is
behind (sources that could not be read show as errors in the report), else 2 when a
source could not be read, else 0.

Usage:
    python packaging/upstream_check.py --report upstream.md
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

MANIFEST = Path(__file__).resolve().parent / "binaries.json"
GITHUB_API = "https://api.github.com"
RIEDL_LATEST = "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip"
BTBN_ASSET = re.compile(r"^ffmpeg-n(\d+(?:\.\d+)+)-.*-win64-lgpl-\d+\.\d+\.zip$")


def _request(url: str, method: str = "GET") -> urllib.request.Request:
    headers = {"User-Agent": "sawt-sakinah-upstream-check"}
    token = os.environ.get("GH_TOKEN")
    if token and url.startswith(GITHUB_API):
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, method=method, headers=headers)


def _github_json(path: str) -> dict:
    with urllib.request.urlopen(_request(f"{GITHUB_API}{path}"), timeout=30) as res:  # noqa: S310
        return json.load(res)


def _version(text: str) -> tuple[int, ...]:
    match = re.search(r"(\d+(?:\.\d+)*)", text)
    if not match:
        raise ValueError(f"no version number in {text!r}")
    return tuple(int(n) for n in match.group(1).split("."))


def latest_deno() -> str:
    return _github_json("/repos/denoland/deno/releases/latest")["tag_name"].removeprefix("v")


def latest_btbn() -> str:
    assets = _github_json("/repos/BtbN/FFmpeg-Builds/releases/tags/latest")["assets"]
    versions = [m.group(1) for a in assets if (m := BTBN_ASSET.match(a["name"]))]
    if not versions:
        raise ValueError("no release-branch win64 LGPL build in BtbN's latest release")
    return max(versions, key=_version)


def latest_riedl(attempts: int = 3) -> str:
    # Read the redirect itself (a GET that is not followed; the server often answers HEAD
    # with 404). The provider names each build's folder <id>_<version>.
    url = urllib.parse.urlsplit(RIEDL_LATEST)
    location = ""
    for attempt in range(attempts):
        if attempt:
            time.sleep(5 * attempt)
        conn = http.client.HTTPSConnection(url.netloc, timeout=30)
        try:
            conn.request("GET", url.path, headers={"User-Agent": "sawt-sakinah-upstream-check"})
            location = conn.getresponse().getheader("Location") or ""
        except OSError:
            continue
        finally:
            conn.close()
        match = re.search(r"/\d+_(\d+(?:\.\d+)*)/", location)
        if match:
            return match.group(1)
    raise ValueError(f"unexpected redirect target {location!r}")


def _source(platform: str, tool: str) -> tuple[str, Callable[[], str]]:
    if tool == "deno":
        return "denoland/deno", latest_deno
    if tool == "ffmpeg" and platform.startswith("windows"):
        return "BtbN FFmpeg-Builds", latest_btbn
    if tool == "ffmpeg" and platform.startswith("macos"):
        return "Martin Riedl", latest_riedl
    raise ValueError(f"no upstream source known for {tool} on {platform}")


def check() -> tuple[str, int]:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    rows, behind, failed = [], False, False
    cache: dict[str, str] = {}
    for platform, tools in manifest["platforms"].items():
        for tool, spec in tools.items():
            pinned = spec["version"]
            source, latest = "?", "?"
            try:
                source, fetch = _source(platform, tool)
                if source not in cache:
                    cache[source] = fetch()
                latest = cache[source]
                is_behind = _version(latest) > _version(pinned)
                status = "**behind**" if is_behind else "current"
                behind |= is_behind
            except Exception as exc:  # noqa: BLE001 - report every source, then fail
                status = f"error: {exc}"
                failed = True
            rows.append(f"| {tool} | {platform} | {source} | {pinned} | {latest} | {status} |")
    report = "\n".join(
        [
            "| Program | Platform | Upstream | Pinned | Latest | Status |",
            "|---|---|---|---|---|---|",
            *rows,
            "",
            "Pins live in `packaging/binaries.json`. To bump one, update its URL, SHA-256,",
            "version, license links and notice, then run "
            "`python packaging/fetch_binaries.py <platform> <dir>` and a release dry run.",
        ]
    )
    return report, 1 if behind else 2 if failed else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--report", type=Path, help="also write the Markdown report here")
    args = parser.parse_args(argv)
    report, code = check()
    print(report)
    if args.report:
        args.report.write_text(report + "\n", encoding="utf-8")
    return code


if __name__ == "__main__":
    sys.exit(main())
