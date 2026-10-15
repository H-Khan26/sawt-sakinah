"""Headless end-to-end check of an installed app (``--self-test``).

Used by CI against the frozen build, and runnable from source. It starts the real service
on a free localhost port with a launch token, then drives it through the public API the
way the window does:

1. helper programs: ffmpeg, ffprobe and Deno resolve to the bundled ``bin/`` copies (when
   frozen; a source checkout only reports where they resolved, and Deno is optional) and
   actually run;
2. the bundled SPA and config are present (required when frozen), and the window
   backend pywebview uses on this OS (WebView2 through pythonnet on Windows, WKWebView
   through PyObjC on macOS) is bundled; no window is opened. The yt-dlp in use (the
   bundled copy, or an opted-in update; see ``ytdlp_updates``) is reported under
   ``ytdlp``, and the bundle must carry the yt-dlp-ejs solver scripts;
3. ``/health`` answers with the token;
4. a 12 s test clip (4 s tone, 4 s silence, 4 s tone) is generated with ffmpeg, uploaded
   (``POST /projects/upload``) and imported;
5. silence detection runs with the ``vad`` detector (it must not fall back to the energy
   gate when frozen), then with the ``ffmpeg`` detector, which must find the gap;
6. the gap is cut in the EDL, the project is exported, and the exported file must exist,
   download, and be shorter than the source;
7. on Windows, deleting the project while a file in it is held open is refused with 409
   and leaves it intact; once released, the project is deleted;
8. recovery and hardening: leftovers planted before the service starts (a
   ``.deleting-*`` folder, an unfinished project, a stale ``.part`` export) are swept at
   startup, a project with ``schema_version`` 999 is listed as unreadable and refused with
   409, and responses carry the Content-Security-Policy and ``nosniff`` headers.

All project and cache data goes to a throwaway temp directory, never the user's. No model
is downloaded (surah recognition is skipped). Each step is logged; the result is also
written as JSON to ``--self-test-report`` when given: once before the checks start and
again at the end, so a crash part-way still leaves a report. Its ``paths`` entry names the
user-data and log directories (``SAWT_DATA_DIR`` moves both). Exit code 0 on success, 1 on
failure.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from . import __version__, runtime

_log = logging.getLogger("sawt_sakinah.selftest")

_JOB_TIMEOUT = 600.0
_CLIP_SECONDS = 12.0
_GAP = (4.0, 8.0)


class SelfTestError(Exception):
    """A self-test check failed."""


class _Client:
    """Minimal JSON client for the local service (token header, no proxy)."""

    def __init__(self, base_url: str, token: str) -> None:
        from .service.security import TOKEN_HEADER

        self.base = base_url
        self.headers = {TOKEN_HEADER: token}
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[bytes] = None,
        json_body: Any = None,
        content_type: Optional[str] = None,
        timeout: float = 60.0,
    ) -> tuple[int, bytes]:
        headers = dict(self.headers)
        if json_body is not None:
            body = json.dumps(json_body).encode()
            content_type = "application/json"
        if content_type:
            headers["Content-Type"] = content_type
        req = urllib.request.Request(self.base + path, data=body, method=method, headers=headers)
        try:
            with self.opener.open(req, timeout=timeout) as res:  # noqa: S310 (local URL)
                return res.status, res.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read()

    def headers_of(self, path: str) -> dict[str, str]:
        """The response headers of ``GET path`` (lower-cased names)."""
        req = urllib.request.Request(self.base + path, headers=self.headers)
        try:
            with self.opener.open(req, timeout=30) as res:  # noqa: S310 (local URL)
                return {k.lower(): v for k, v in res.headers.items()}
        except urllib.error.HTTPError as exc:
            return {k.lower(): v for k, v in exc.headers.items()}

    def json(self, method: str, path: str, expect: int = 200, **kwargs: Any) -> Any:
        status, data = self.request(method, path, **kwargs)
        if status != expect:
            text = data.decode("utf-8", "replace")[:500]
            raise SelfTestError(f"{method} {path} returned {status} (expected {expect}): {text}")
        return json.loads(data) if data else None

    def wait_job(self, job_id: str, timeout: float = _JOB_TIMEOUT) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            job = self.json("GET", f"/jobs/{job_id}")
            if job["state"] == "succeeded":
                return job.get("result") or {}
            if job["state"] == "failed":
                error = f"{job.get('error_type')}: {job.get('error')}"
                raise SelfTestError(f"job {job['kind']} failed: {error}")
            if time.monotonic() > deadline:
                raise SelfTestError(f"job {job['kind']} did not finish within {timeout:.0f} s")
            time.sleep(0.25)


def _multipart(field: str, filename: str, payload: bytes, mime: str) -> tuple[bytes, str]:
    boundary = uuid.uuid4().hex
    head = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode()
    tail = f"\r\n--{boundary}--\r\n".encode()
    return head + payload + tail, f"multipart/form-data; boundary={boundary}"


def _user_paths() -> dict[str, Optional[str]]:
    """The app's user-data and log directories (``None`` when one can't be resolved)."""
    paths: dict[str, Optional[str]] = {}
    for name, resolve in (("data_dir", runtime.data_dir), ("logs_dir", runtime.logs_dir)):
        try:
            paths[name] = str(resolve())
        except Exception:  # noqa: BLE001 - the report must still be written
            paths[name] = None
    return paths


class _Run:
    """Collects step results for the report."""

    def __init__(self) -> None:
        self.report: dict[str, Any] = {
            "ok": False,
            "version": __version__,
            "frozen": runtime.FROZEN,
            "platform": sys.platform,
            "python": sys.version.split()[0],
            "started_at": datetime.now(timezone.utc).isoformat(),
            "paths": _user_paths(),
            "tools": {},
            "steps": [],
            "error": None,
        }

    @contextmanager
    def step(self, name: str) -> Iterator[dict]:
        """Run one step; the yielded dict becomes its ``detail``."""
        detail: dict[str, Any] = {}
        entry: dict[str, Any] = {"name": name, "ok": False, "detail": detail}
        self.report["steps"].append(entry)
        _log.info("self-test: %s ...", name)
        start = time.monotonic()
        try:
            yield detail
        except Exception as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"
            _log.error("self-test: %s FAILED: %s", name, entry["error"])
            raise
        finally:
            entry["seconds"] = round(time.monotonic() - start, 3)
        entry["ok"] = True
        _log.info("self-test: %s ok (%.1f s) %s", name, entry["seconds"], detail or "")


def _check_tools(run: _Run) -> None:
    from .proc import run as run_proc

    with run.step("tools") as detail:
        missing = []
        for name in runtime.TOOLS:
            bundled = runtime.bundled_tool(name)
            info: dict[str, Any] = {"bundled": str(bundled) if bundled else None}
            try:
                path = runtime.tool_path(name)
            except runtime.ToolNotFoundError as exc:
                info.update(path=None, error=str(exc))
                run.report["tools"][name] = info
                # Deno is optional in a source checkout (YouTube extraction only).
                if runtime.FROZEN or name != "deno":
                    missing.append(name)
                continue
            info["path"] = path
            if runtime.FROZEN and (bundled is None or Path(path) != bundled):
                missing.append(f"{name} (not the bundled copy: {path})")
            res = run_proc([path, "-version" if name != "deno" else "--version"], timeout=60)
            first = (res.stdout or res.stderr or "").strip().splitlines()
            info["version"] = first[0] if first else None
            if res.returncode != 0:
                missing.append(f"{name} (exit {res.returncode})")
            run.report["tools"][name] = info
        detail.update({name: info.get("path") for name, info in run.report["tools"].items()})
        if missing:
            raise SelfTestError(f"helper programs missing or broken: {', '.join(missing)}")


def _check_bundle(run: _Run) -> None:
    from .config import config_path

    with run.step("bundle") as detail:
        static = runtime.static_dir()
        detail.update(
            bundle_root=str(runtime.bundle_root()),
            static_dir=str(static),
            spa_built=(static / "index.html").is_file(),
            config=str(config_path()),
        )
        if runtime.FROZEN and not detail["spa_built"]:
            raise SelfTestError(f"the bundled SPA is missing: {static}")


#: The window backend pywebview loads on each OS, by module name. The macOS framework
#: bindings are imported for real (they only load the frameworks); the window modules
#: are only located, because importing them starts GUI machinery.
_GUI_IMPORTS = {"darwin": ("Foundation", "AppKit", "WebKit")}
_GUI_MODULES = {
    "darwin": ("webview", "webview.platforms.cocoa"),
    "win32": ("webview", "webview.platforms.winforms", "webview.platforms.edgechromium", "clr"),
}


def _check_gui(run: _Run) -> None:
    import importlib
    import importlib.util

    with run.step("gui") as detail:
        missing = []
        for name in _GUI_IMPORTS.get(sys.platform, ()):
            try:
                importlib.import_module(name)
            except ImportError as exc:
                missing.append(f"{name} ({exc})")
        for name in _GUI_MODULES.get(sys.platform, ()):
            try:
                found = importlib.util.find_spec(name) is not None
            except ImportError:
                found = False
            if not found:
                missing.append(name)
        detail["missing"] = missing
        # A source checkout may run headless without the desktop extra.
        if missing and runtime.FROZEN:
            raise SelfTestError(f"window components missing: {', '.join(missing)}")


_STALE = 24 * 3600.0  # seconds; older than the sweep's grace period
_NEWER_PROJECT = "9" * 32


def _plant_leftovers(projects_dir: Path) -> dict[str, Path]:
    """Files an interrupted run would leave, plus a project from a newer app version."""
    trash = projects_dir / ".deleting-0123456789abcdef-00000000"
    unfinished = projects_dir / ("e" * 32)
    keeper = projects_dir / ("f" * 32)
    part = keeper / "exports" / "0123456789abcdef.part.mp3"
    newer = projects_dir / _NEWER_PROJECT
    for folder in (trash, unfinished / "audio", keeper / "exports", newer):
        folder.mkdir(parents=True, exist_ok=True)
    (trash / "source.mp3").write_bytes(b"x")
    (unfinished / "audio" / "source.webm.part").write_bytes(b"x")
    part.write_bytes(b"x")
    # Not a loadable project; the sweep only looks for its project.json.
    (keeper / "project.json").write_text("{}", encoding="utf-8")
    (newer / "project.json").write_text(
        json.dumps({"schema_version": 999, "id": _NEWER_PROJECT}), encoding="utf-8"
    )
    old = time.time() - _STALE
    for path in (
        unfinished / "audio" / "source.webm.part",
        unfinished / "audio",
        unfinished,
        part,
        trash / "source.mp3",
        trash,
    ):
        os.utime(path, (old, old))
    return {"trash": trash, "unfinished": unfinished, "part": part, "keeper": keeper}


def _check_recovery(run: _Run, client: _Client, planted: dict[str, Path]) -> None:
    from .service.security import CONTENT_SECURITY_POLICY

    with run.step("startup-sweep") as detail:
        left = [name for name in ("trash", "unfinished", "part") if planted[name].exists()]
        detail["left"] = left
        if left:
            raise SelfTestError(f"the startup sweep left: {', '.join(left)}")
        if not (planted["keeper"] / "project.json").is_file():
            raise SelfTestError("the startup sweep removed a finished project")

    with run.step("schema-version") as detail:
        listed = {p["id"]: p for p in client.json("GET", "/projects")["projects"]}
        entry = listed.get(_NEWER_PROJECT)
        detail["listed"] = entry
        if entry is None or "newer version" not in (entry.get("unreadable") or ""):
            raise SelfTestError(f"a schema_version 999 project was listed as {entry}")
        status, data = client.request("GET", f"/projects/{_NEWER_PROJECT}")
        detail["status"] = status
        if status != 409 or b"ProjectTooNewError" not in data:
            raise SelfTestError(f"opening a schema_version 999 project returned {status}")
        status, _ = client.request("DELETE", f"/projects/{_NEWER_PROJECT}")
        if status != 204:
            raise SelfTestError(f"deleting a schema_version 999 project returned {status}")

    with run.step("headers") as detail:
        paths = ["/health"] + (["/"] if (runtime.static_dir() / "index.html").is_file() else [])
        for path in paths:
            headers = client.headers_of(path)
            csp = headers.get("content-security-policy")
            if csp != CONTENT_SECURITY_POLICY:
                raise SelfTestError(f"{path} has Content-Security-Policy {csp!r}")
            if headers.get("x-content-type-options") != "nosniff":
                raise SelfTestError(f"{path} lacks X-Content-Type-Options: nosniff")
        detail["checked"] = paths


def _check_ytdlp(run: _Run) -> None:
    from . import ytdlp_updates

    with run.step("ytdlp") as detail:
        info = ytdlp_updates.activate()
        import yt_dlp

        detail.update(
            source=info.get("source"),
            version=yt_dlp.version.__version__,
            ejs_version=info.get("ejs_version"),
            bundled_version=info.get("bundled_version"),
            path=str(Path(yt_dlp.__file__).parent),
            fallback=info.get("fallback"),
        )
        run.report["ytdlp"] = dict(detail)
        # Without the solver scripts YouTube imports fail on the challenge step.
        if runtime.FROZEN and not detail["ejs_version"]:
            raise SelfTestError("yt-dlp-ejs (the YouTube challenge solver) is missing")


def _make_clip(path: Path) -> None:
    from .proc import run as run_proc

    a, b = _GAP
    # Tone, silence, tone: the expression is 0 inside [a, b).
    source = (
        f"aevalsrc='0.5*sin(2*PI*440*t)*(lt(t,{a})+gte(t,{b}))'"
        f":s=44100:c=mono:d={_CLIP_SECONDS}"
    )
    res = run_proc(
        ["ffmpeg", "-hide_banner", "-nostdin", "-y", "-f", "lavfi", "-i", source, str(path)],
        timeout=120,
    )
    if res.returncode != 0 or not path.is_file():
        raise SelfTestError(f"ffmpeg could not generate the test clip: {res.stderr[-500:]}")


def _exercise_api(run: _Run, client: _Client, workdir: Path, projects_dir: Path) -> None:
    clip = workdir / "self-test.wav"
    with run.step("clip") as detail:
        _make_clip(clip)
        detail["bytes"] = clip.stat().st_size

    with run.step("upload") as detail:
        body, ctype = _multipart("file", clip.name, clip.read_bytes(), "audio/wav")
        created = client.json(
            "POST", "/projects/upload", expect=202, body=body, content_type=ctype
        )
        project_id = created["project_id"]
        detail["project_id"] = project_id
        detail["result"] = client.wait_job(created["job_id"])
        project = client.json("GET", f"/projects/{project_id}")
        duration = project["audio_source"]["duration_sec"]
        detail["duration_sec"] = duration
        detail["has_speech_map"] = project["audio_source"]["has_speech_map"]
        if abs(duration - _CLIP_SECONDS) > 0.5:
            raise SelfTestError(f"imported duration {duration:.2f} s, expected ~{_CLIP_SECONDS} s")
        if runtime.FROZEN and not detail["has_speech_map"]:
            raise SelfTestError("no speech map was computed (is onnxruntime bundled?)")

    with run.step("silence-vad") as detail:
        job = client.json(
            "POST", f"/projects/{project_id}/detect/silence", expect=202,
            json_body={"detector": "vad"},
        )
        result = client.wait_job(job["job_id"])
        detail.update(result)
        if runtime.FROZEN and result.get("fallback"):
            raise SelfTestError(f"the vad detector fell back: {result['fallback']}")

    with run.step("silence-ffmpeg") as detail:
        job = client.json(
            "POST", f"/projects/{project_id}/detect/silence", expect=202,
            json_body={"detector": "ffmpeg", "min_silence_duration": 2.0},
        )
        detail.update(client.wait_job(job["job_id"]))
        silences = client.json("GET", f"/projects/{project_id}")["silences"]
        detail["silences"] = [[s["start"], s["end"]] for s in silences]
        gap = next(
            (s for s in silences if s["start"] < _GAP[0] + 0.5 and s["end"] > _GAP[1] - 0.5),
            None,
        )
        if gap is None:
            raise SelfTestError(f"the {_GAP[0]:.0f}-{_GAP[1]:.0f} s gap was not detected")

    with run.step("export") as detail:
        cut = {"type": "cut", "start": gap["start"], "end": gap["end"]}
        client.json("PUT", f"/projects/{project_id}/edl", json_body={"operations": [cut]})
        job = client.json("POST", f"/projects/{project_id}/export", expect=202, json_body={})
        artifact_id = client.wait_job(job["job_id"])["artifact_id"]
        project = client.json("GET", f"/projects/{project_id}")
        artifact = next(a for a in project["exports"] if a["id"] == artifact_id)
        files = [
            p for p in (projects_dir / project_id / "exports").glob(f"{artifact_id}.*")
            if p.is_file()
        ]
        if not files or files[0].stat().st_size == 0:
            raise SelfTestError("the exported file is missing or empty")
        status, data = client.request("GET", artifact["download_url"])
        if status != 200 or not data:
            raise SelfTestError(f"downloading the export returned {status}")
        detail.update(
            format=artifact["format"],
            duration_sec=artifact["duration_sec"],
            bytes=files[0].stat().st_size,
        )
        if artifact["duration_sec"] > _CLIP_SECONDS - 2.0:
            raise SelfTestError(
                f"the export is {artifact['duration_sec']:.2f} s; the cut was not applied"
            )

    with run.step("delete-locked") as detail:
        # Only Windows refuses to move a folder while a file in it is open.
        if os.name != "nt":
            detail["skipped"] = "open files do not lock folders on this OS"
        else:
            audio = next((projects_dir / project_id / "audio").glob("*.mp3"))
            with open(audio, "rb"):
                status, data = client.request("DELETE", f"/projects/{project_id}")
            detail["status"] = status
            if status != 409 or b"ProjectInUseError" not in data:
                raise SelfTestError(f"DELETE of a locked project returned {status}: {data[:200]!r}")
            listed = [p["id"] for p in client.json("GET", "/projects")["projects"]]
            intact = (projects_dir / project_id / "project.json").is_file()
            if project_id not in listed or not intact:
                raise SelfTestError("a refused delete changed the project")

    with run.step("delete") as detail:
        status, data = client.request("DELETE", f"/projects/{project_id}")
        if status != 204:
            raise SelfTestError(f"DELETE returned {status}: {data[:200]!r}")
        if (projects_dir / project_id).exists():
            raise SelfTestError("the project directory is still there after delete")
        detail["project_id"] = project_id


def run_self_test(host: str = "127.0.0.1", report_path: Optional[str] = None) -> int:
    """Run every check; returns the process exit code (0 success, 1 failure)."""
    from .desktop import Service, new_token, pick_port

    run = _Run()
    _write_report(run.report, report_path)  # replaced by the final report below
    workdir = Path(tempfile.mkdtemp(prefix="sawt-selftest-"))
    service: Optional[Service] = None
    try:
        _check_tools(run)
        _check_bundle(run)
        _check_gui(run)
        _check_ytdlp(run)

        with run.step("service") as detail:
            from .service.settings import ServiceSettings

            projects_dir = workdir / "projects"
            planted = _plant_leftovers(projects_dir)
            settings = ServiceSettings(
                projects_dir=projects_dir,
                cache_dir=workdir / "cache",
                auth_token=new_token(),
            )
            service = Service(settings, host, pick_port(host))
            service.start()
            client = _Client(service.url, service.token)
            health = client.json("GET", "/health")
            if health.get("version") != __version__:
                raise SelfTestError(f"/health answered {health}")
            bad, _ = _Client(service.url, "wrong-token").request("GET", "/health", timeout=5)
            if bad != 401:
                raise SelfTestError(f"/health without the token returned {bad}, expected 401")
            detail.update(url=service.url, health=health)

        _check_recovery(run, client, planted)
        _exercise_api(run, client, workdir, projects_dir)
        run.report["ok"] = True
    except Exception as exc:  # noqa: BLE001 - every failure ends up in the report
        run.report["error"] = f"{type(exc).__name__}: {exc}"
        if not isinstance(exc, SelfTestError):
            _log.exception("self-test crashed")
    finally:
        if service is not None:
            service.stop()
        shutil.rmtree(workdir, ignore_errors=True)
        run.report["finished_at"] = datetime.now(timezone.utc).isoformat()
        _write_report(run.report, report_path)

    _log.info("self-test %s", "PASSED" if run.report["ok"] else f"FAILED: {run.report['error']}")
    return 0 if run.report["ok"] else 1


def _write_report(report: dict, report_path: Optional[str]) -> None:
    if not report_path:
        return
    try:
        path = Path(report_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    except OSError:
        _log.exception("could not write the self-test report to %s", report_path)


__all__ = ["SelfTestError", "run_self_test"]
