"""Import every platform's canary post with ``sawt extract`` and report the outcomes.

The canary links come from the platform registry (``Platform.canary_url`` in
``sawt_sakinah/extraction/platforms.py``) through ``sawt platforms``, so adding a platform
adds its canary. Each import runs from the source checkout in a fresh scratch
``SAWT_DATA_DIR`` (no cache, no preferences, nothing written to the user's folders) and its
exit code (see ``sawt_sakinah/cli.py``) becomes an outcome:

    0 ok · 3 blocked (bot check, sign-in or rate limit: not exercised) · 4 outdated ·
    5 input (the canary link itself is wrong) · anything else failed

A failed import (exit 1) is tried once more, so one network hiccup does not fail the run;
an import that times out is stopped with its child processes and not retried. The daily
``link-canary`` workflow runs the canaries with the locked yt-dlp and again with the newest
nightly, and the weekly rebuild runs them with the newest stable.

Commands:
    run              import the canaries; writes a JSON result for one yt-dlp version
    install-nightly  put the newest yt-dlp nightly (and the yt-dlp-ejs it pins) in a folder,
                     to pass to ``run --ytdlp-dir`` (the app's curl_cffi stays in use)
    report           Markdown matrix of platforms x versions from the JSON results; exit
                     code 1 when a gating (non ``--advisory``) run is outdated or failed. In
                     GitHub Actions it also sets the step output ``blocked`` (true when a
                     gating run had a blocked import)

Usage:
    python packaging/link_canary.py run --label locked --out locked.json
    python packaging/link_canary.py install-nightly build/ytdlp-nightly
    python packaging/link_canary.py run --label nightly --advisory \\
        --ytdlp-dir build/ytdlp-nightly --out nightly.json
    python packaging/link_canary.py report locked.json nightly.json --markdown canary.md
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The exit codes of ``sawt extract`` (cli.py) and what they mean for a canary.
OUTCOMES = {0: "ok", 3: "blocked", 4: "outdated", 5: "input"}
# Outcomes that fail a gating run. "blocked" says nothing about yt-dlp.
FAILING = ("outdated", "input", "failed")

# The failure line ``sawt extract`` prints after "error: <message>".
_ERROR_TYPE = re.compile(r"^error_type=(\S+) ")
_EJS_PIN = re.compile(
    r"yt-dlp-ejs\s*==\s*([0-9][0-9A-Za-z.]*)\s*;\s*extra\s*==\s*['\"]default['\"]"
)


def _in_actions() -> bool:
    return os.environ.get("GITHUB_ACTIONS") == "true"


def _env(data_dir: Path, ytdlp_dir: Path | None) -> dict[str, str]:
    env = dict(os.environ)
    env["SAWT_DATA_DIR"] = str(data_dir)
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    if ytdlp_dir is not None:
        # Ahead of site-packages, as the app puts a downloaded yt-dlp ahead of its own.
        paths = [str(ytdlp_dir.resolve()), env.get("PYTHONPATH", "")]
        env["PYTHONPATH"] = os.pathsep.join(p for p in paths if p)
    return env


def _kill_tree(proc: subprocess.Popen) -> None:
    """Stop ``proc`` and the programs it started (yt-dlp's ffmpeg)."""
    if os.name == "nt":
        subprocess.run(  # noqa: S603
            ["taskkill", "/F", "/T", "/PID", str(proc.pid)],  # noqa: S607
            capture_output=True,
        )
    else:
        os.killpg(proc.pid, signal.SIGKILL)
    proc.wait()


def _sawt(
    args: list[str], env: dict[str, str], work: Path, timeout: float
) -> tuple[int | None, str, str]:
    """Run ``python -m sawt_sakinah <args>`` with its output in files under ``work`` (a
    child that outlives it could hold a pipe open). Returns the exit code (``None`` after
    a timeout), stdout and stderr."""
    stdout, stderr = work / "stdout.txt", work / "stderr.txt"
    with stdout.open("wb") as out, stderr.open("wb") as err:
        proc = subprocess.Popen(  # noqa: S603
            [sys.executable, "-m", "sawt_sakinah", *args],
            cwd=ROOT,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=out,
            stderr=err,
            start_new_session=os.name != "nt",
        )
        try:
            code = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill_tree(proc)
            code = None
    return (
        code,
        stdout.read_text(encoding="utf-8", errors="replace"),
        stderr.read_text(encoding="utf-8", errors="replace"),
    )


def _status(work: Path, ytdlp_dir: Path | None) -> dict:
    """``sawt platforms`` under the run's yt-dlp (its version, capabilities and each
    platform's status and canary link), or ``{"error": ...}``."""
    work.mkdir(parents=True)
    try:
        code, stdout, stderr = _sawt(["platforms"], _env(work / "data", ytdlp_dir), work, 120)
        if code == 0:
            return json.loads(stdout)
        detail = (stderr.strip().splitlines() or [f"exit code {code}"])[-1]
    except (OSError, ValueError) as exc:
        detail = f"{type(exc).__name__}: {exc}"
    return {"error": f"sawt platforms failed: {detail}"}


def _import(url: str, work: Path, ytdlp_dir: Path | None, timeout: float) -> dict:
    """One ``sawt extract`` of ``url`` in a fresh data folder under ``work``."""
    work.mkdir(parents=True)
    started = time.monotonic()
    code, stdout, stderr = _sawt(
        ["extract", url, "-o", str(work / "out")], _env(work / "data", ytdlp_dir), work, timeout
    )
    result = {
        "outcome": OUTCOMES.get(code, "failed"),
        "exit_code": code,
        "error_type": None,
        "message": None,
        "seconds": round(time.monotonic() - started, 1),
        "log": stderr + stdout,
    }
    for line in stderr.splitlines():
        if line.startswith("error: ") and result["message"] is None:
            result["message"] = line.removeprefix("error: ")
        elif m := _ERROR_TYPE.match(line):
            result["error_type"] = m.group(1)
    if code is None:
        result["message"] = f"timed out after {timeout:.0f} s"
    elif code == 0:
        lines = stdout.strip().splitlines()
        path = Path(lines[-1]) if lines else None
        if path is None or not path.is_file() or path.stat().st_size == 0:
            result.update(outcome="failed", message="sawt extract wrote no audio file")
    elif result["message"] is None:
        tail = stderr.strip().splitlines()
        result["message"] = tail[-1] if tail else f"exit code {code}"
    return result


def run(label: str, out: Path, ytdlp_dir: Path | None, advisory: bool, timeout: float,
        keep: bool) -> int:
    work = Path(tempfile.mkdtemp(prefix="sawt-canary-"))
    try:
        status = _status(work / "status", ytdlp_dir)
        if "error" in status:
            print(f"error: {status['error']}", file=sys.stderr)
        results = []
        for platform in status.get("platforms") or []:
            pid, plabel, url = platform["id"], platform["label"], platform["canary_url"]
            if not url:
                continue
            for attempt in (1, 2):
                result = _import(url, work / f"{pid}-{attempt}", ytdlp_dir, timeout)
                if result["exit_code"] != 1 or attempt == 2:
                    break
                print(f"{plabel}: {result['message']}; trying once more", flush=True)
            log = result["log"]
            if _in_actions():
                print(f"::group::{plabel} ({label}): {result['outcome']}", flush=True)
            else:
                print(f"----- {plabel} ({label}): {result['outcome']}", flush=True)
            print(log.rstrip(), flush=True)
            if _in_actions():
                print("::endgroup::", flush=True)
            results.append(
                {"platform": pid, "label": plabel, "url": url, "attempts": attempt, **result}
            )
    finally:
        if keep:
            print(f"Kept the scratch folder {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)
            if work.exists():
                # A killed import's children can hold its files for a moment (Windows).
                time.sleep(3)
                shutil.rmtree(work, ignore_errors=True)
    data ={"label": label, "advisory": advisory, "status": status, "results": results}
    out.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    for r in results:
        print(f"{r['label']}: {r['outcome']}" + (f" ({r['message']})" if r["message"] else ""))
    return 0


def install_nightly(dest: Path) -> int:
    """The newest yt-dlp on PyPI (nightlies are pre-releases there) and its pinned
    yt-dlp-ejs, as wheels only, into ``dest``."""
    pip = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check",
           "--no-deps", "--only-binary", ":all:", "--upgrade", "--target", str(dest)]
    subprocess.run([*pip, "--pre", "yt-dlp"], check=True)  # noqa: S603
    dist = next(importlib.metadata.distributions(name="yt-dlp", path=[str(dest)]), None)
    if dist is None:
        print(f"error: no yt-dlp was installed into {dest}", file=sys.stderr)
        return 1
    pins = [m.group(1) for r in dist.requires or [] if (m := _EJS_PIN.fullmatch(r.strip()))]
    if not pins:
        print(f"error: yt-dlp {dist.version} pins no yt-dlp-ejs version", file=sys.stderr)
        return 1
    subprocess.run([*pip, f"yt-dlp-ejs=={pins[0]}"], check=True)  # noqa: S603
    print(f"yt-dlp {dist.version} with yt-dlp-ejs {pins[0]} in {dest}")
    return 0


def _column(data: dict) -> str:
    status = data.get("status") or {}
    version = (status.get("ytdlp") or {}).get("version") or "unknown"
    head = f"{data['label']}: yt-dlp {version}"
    return head + (" (advisory)" if data.get("advisory") else "")


def _cell(result: dict | None) -> str:
    if result is None:
        return "not run"
    outcome = result["outcome"]
    text = outcome if outcome in ("ok", "blocked") else f"**{outcome.upper()}**"
    if result.get("error_type") and outcome != "ok":
        text += f" ({result['error_type']})"
    return text


def report(paths: list[Path], markdown: Path | None) -> int:
    runs = [json.loads(p.read_text(encoding="utf-8")) for p in paths]
    platforms: dict[str, str] = {}
    for data in runs:
        for r in data["results"]:
            platforms.setdefault(r["platform"], r["label"])

    lines = [
        "## Link canary",
        "",
        "| Platform | " + " | ".join(_column(d) for d in runs) + " |",
        "| --- |" + " --- |" * len(runs),
    ]
    for pid, plabel in platforms.items():
        cells = []
        for data in runs:
            found = next((r for r in data["results"] if r["platform"] == pid), None)
            cells.append(_cell(found))
        lines.append(f"| {plabel} | " + " | ".join(cells) + " |")
    lines += [
        "",
        "*blocked*: the site refused the runner (a bot check, sign-in wall or rate limit), "
        "so the import was not exercised. An advisory column never fails the run.",
    ]

    details, failing = [], []
    for data in runs:
        status = data.get("status") or {}
        if status.get("error"):
            details.append(f"- **{data['label']}**: {status['error']}")
            if not data.get("advisory"):
                failing.append(f"every platform ({data['label']})")
        else:
            caps = ", ".join(status.get("capabilities") or []) or "none"
            details.append(
                f"- **{data['label']}**: yt-dlp {status['ytdlp']['version']}, curl_cffi "
                f"{status.get('curl_cffi') or 'missing'}, capabilities: {caps}"
            )
            # An unavailable platform shows up as its canary's outcome below.
            for p in status.get("platforms") or []:
                if p.get("limited"):
                    details.append(f"  - {p['label']} is limited: {p['reason']}")
        for r in data["results"]:
            if r["outcome"] == "ok":
                continue
            exit_code = r["exit_code"] if r["exit_code"] is not None else "none"
            details.append(
                f"  - {r['label']}: {r['outcome']} (exit code {exit_code}, "
                f"{r.get('error_type') or 'no error type'}): {r.get('message') or ''}"
            )
            if r["outcome"] in FAILING and not data.get("advisory"):
                failing.append(f"{r['label']} ({data['label']})")
    lines += ["", "### Details", "", *details]
    if failing:
        lines += ["", f"**Failing:** {', '.join(failing)}."]
    text = "\n".join(lines) + "\n"
    print(text)
    if markdown is not None:
        markdown.write_text(text, encoding="utf-8")

    if _in_actions():
        for data in runs:
            for r in data["results"]:
                where = f"{r['label']} ({data['label']})"
                if r["outcome"] == "blocked":
                    print(f"::warning::{where} was blocked, so the import was not exercised")
                elif r["outcome"] in FAILING:
                    kind = "warning" if data.get("advisory") else "error"
                    print(f"::{kind}::{where}: {r['outcome']}: {r.get('message') or ''}")
    # A passing run with blocked imports did not check every platform; the workflow then
    # leaves its tracking issue open.
    blocked = any(
        r["outcome"] == "blocked"
        for data in runs
        if not data.get("advisory")
        for r in data["results"]
    )
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as fh:
            fh.write(f"blocked={'true' if blocked else 'false'}\n")
    return 1 if failing else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    p_run = sub.add_parser("run", help="import every canary link with one yt-dlp")
    p_run.add_argument("--label", required=True, help='the column name, e.g. "locked"')
    p_run.add_argument("--out", type=Path, required=True, help="JSON result file")
    p_run.add_argument("--ytdlp-dir", type=Path, help="a folder holding the yt-dlp to use")
    p_run.add_argument("--advisory", action="store_true", help="report, but never fail")
    p_run.add_argument("--timeout", type=float, default=180, help="seconds per import")
    p_run.add_argument("--keep", action="store_true", help="keep the scratch folder")

    p_nightly = sub.add_parser("install-nightly", help="the newest yt-dlp nightly into DIR")
    p_nightly.add_argument("dest", type=Path)

    p_report = sub.add_parser("report", help="Markdown matrix from run results")
    p_report.add_argument("results", type=Path, nargs="+")
    p_report.add_argument("--markdown", type=Path, help="also write the report here")

    args = parser.parse_args(argv)
    if args.command == "run":
        return run(args.label, args.out, args.ytdlp_dir, args.advisory, args.timeout, args.keep)
    if args.command == "install-nightly":
        return install_nightly(args.dest)
    return report(args.results, args.markdown)


if __name__ == "__main__":
    sys.exit(main())
