"""Download the pinned helper programs (ffmpeg, ffprobe, Deno) for one platform.

Reads ``packaging/binaries.json``, downloads each archive, verifies its SHA-256 (any
mismatch aborts), extracts only the listed executables into ``<dest>/bin/`` and writes
each tool's license texts and source notice into ``<dest>/THIRD_PARTY/<tool>/``.
Verified downloads are kept in ``<dest>/downloads/`` and reused on the next run.

Usage:
    python packaging/fetch_binaries.py windows-x64 packaging/build/vendor
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import sys
import tarfile
import time
import urllib.request
import zipfile
from pathlib import Path

MANIFEST = Path(__file__).resolve().parent / "binaries.json"
CHUNK = 1 << 20


class FetchError(RuntimeError):
    pass


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(CHUNK), b""):
            digest.update(block)
    return digest.hexdigest()


def _download(url: str, target: Path, attempts: int = 3) -> None:
    partial = target.with_name(target.name + ".part")
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "sawt-sakinah-build"})
            with urllib.request.urlopen(req, timeout=60) as res, partial.open("wb") as fh:  # noqa: S310
                shutil.copyfileobj(res, fh, CHUNK)
            partial.replace(target)
            return
        except OSError as err:
            partial.unlink(missing_ok=True)
            if attempt == attempts:
                raise FetchError(f"download failed: {url}: {err}") from err
            print(f"  retrying after error: {err}", file=sys.stderr)
            time.sleep(5 * attempt)


def fetch_verified(url: str, sha256: str, cache: Path) -> Path:
    """The file at ``url``, downloaded once into ``cache`` and checked against ``sha256``."""
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / f"{sha256[:16]}-{url.rsplit('/', 1)[-1]}"
    if target.is_file() and _sha256(target) == sha256:
        print(f"  cached   {target.name}")
        return target
    print(f"  download {url}")
    _download(url, target)
    actual = _sha256(target)
    if actual != sha256:
        target.unlink(missing_ok=True)
        raise FetchError(f"SHA-256 mismatch for {url}\n  expected {sha256}\n  got      {actual}")
    print(f"  verified sha256 {actual}")
    return target


def _extract_members(archive: Path, members: dict[str, str], out_dir: Path) -> list[Path]:
    """Copy archive member ``members[name]`` to ``out_dir / name`` for each entry."""
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as zf:
            for name, member in members.items():
                dest = out_dir / name
                try:
                    with zf.open(member) as src, dest.open("wb") as dst:
                        shutil.copyfileobj(src, dst, CHUNK)
                except KeyError as err:
                    raise FetchError(f"{archive.name} has no member {member}") from err
                written.append(dest)
    else:
        with tarfile.open(archive) as tf:
            for name, member in members.items():
                src = tf.extractfile(member)
                if src is None:
                    raise FetchError(f"{archive.name} has no regular file {member}")
                dest = out_dir / name
                with src, dest.open("wb") as dst:
                    shutil.copyfileobj(src, dst, CHUNK)
                written.append(dest)
    return written


def fetch(platform: str, dest: Path) -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    try:
        tools = manifest["platforms"][platform]
    except KeyError:
        known = ", ".join(manifest["platforms"])
        raise FetchError(f"unknown platform {platform!r} (known: {known})") from None

    bin_dir = dest / "bin"
    third_party = dest / "THIRD_PARTY"
    cache = dest / "downloads"
    for stale in (bin_dir, third_party):
        shutil.rmtree(stale, ignore_errors=True)

    for tool, spec in tools.items():
        print(f"{tool} {spec['version']}")
        archive = fetch_verified(spec["url"], spec["sha256"], cache)
        for exe in _extract_members(archive, spec["executables"], bin_dir):
            if os.name != "nt":
                exe.chmod(exe.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
            print(f"  -> {exe}")

        license_dir = third_party / tool
        _extract_members(archive, spec.get("license_members", {}), license_dir)
        for name, lic in spec.get("licenses", {}).items():
            shutil.copyfile(fetch_verified(lic["url"], lic["sha256"], cache), license_dir / name)
        (license_dir / "SOURCE.txt").write_text("\n".join(spec["notice"]) + "\n", encoding="utf-8")
        meta = {"name": tool, "version": spec["version"], "license": spec["license_name"]}
        (license_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("platform", help="manifest platform key, e.g. windows-x64")
    parser.add_argument("dest", type=Path, help="output directory (gets bin/ and THIRD_PARTY/)")
    args = parser.parse_args(argv)
    sys.stdout.reconfigure(line_buffering=True)  # keep progress and errors in order in CI logs
    try:
        fetch(args.platform, args.dest.resolve())
    except FetchError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
