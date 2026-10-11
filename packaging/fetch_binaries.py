"""Download the pinned helper programs (ffmpeg, ffprobe, Deno) for one platform.

Reads ``packaging/binaries.json``, downloads each archive (.zip or a tarball such as
.tar.xz), verifies its SHA-256 (any mismatch aborts), extracts only the listed executables
into ``<dest>/bin/``, checks that each is a program for the target platform (PE on Windows,
arm64 Mach-O on macOS) and writes each tool's license texts and source notice into
``<dest>/THIRD_PARTY/<tool>/``. Verified downloads are kept in ``<dest>/downloads/`` and
reused on the next run. It runs on any OS, so a manifest change can be checked anywhere.

Usage:
    python packaging/fetch_binaries.py windows-x64 packaging/build/vendor
    python packaging/fetch_binaries.py macos-arm64 packaging/build/vendor
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import struct
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


_MACHO_64 = 0xFEEDFACF
_FAT = 0xCAFEBABE  # universal binary, 32-bit fat_arch entries
_FAT_64 = 0xCAFEBABF  # universal binary, 64-bit fat_arch_64 entries
_CPU_ARM64 = 0x0100000C


def _is_arm64_macho(head: bytes) -> bool:
    """A thin arm64 Mach-O, or a universal binary with an arm64 slice."""
    if len(head) < 8:
        return False
    if struct.unpack_from("<II", head) == (_MACHO_64, _CPU_ARM64):
        return True
    magic, count = struct.unpack_from(">II", head)
    if magic not in (_FAT, _FAT_64) or not 0 < count <= 32:  # Java class files share _FAT
        return False
    entry = 20 if magic == _FAT else 32
    if len(head) < 8 + count * entry:
        return False
    cputypes = [struct.unpack_from(">I", head, 8 + i * entry)[0] for i in range(count)]
    return _CPU_ARM64 in cputypes


def _check_binary(path: Path, platform: str) -> None:
    """Raise when ``path`` is not an executable for ``platform`` (PE, or arm64 Mach-O)."""
    with path.open("rb") as fh:
        head = fh.read(8 + 32 * 32)
    if platform.startswith("windows"):
        ok = head[:2] == b"MZ"
    elif platform == "macos-arm64":
        ok = _is_arm64_macho(head)
    else:
        raise FetchError(f"no executable format known for platform {platform!r}")
    if not ok:
        raise FetchError(f"{path.name} is not a {platform} executable")


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
        archives = []
        for part in spec.get("archives") or [spec]:
            archive = fetch_verified(part["url"], part["sha256"], cache)
            archives.append(archive)
            for exe in _extract_members(archive, part["executables"], bin_dir):
                _check_binary(exe, platform)
                if os.name != "nt":
                    exe.chmod(exe.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
                print(f"  -> {exe}")

        license_dir = third_party / tool
        _extract_members(archives[0], spec.get("license_members", {}), license_dir)
        for name, lic in spec.get("licenses", {}).items():
            shutil.copyfile(fetch_verified(lic["url"], lic["sha256"], cache), license_dir / name)
        (license_dir / "SOURCE.txt").write_text("\n".join(spec["notice"]) + "\n", encoding="utf-8")
        meta = {"name": tool, "version": spec["version"], "license": spec["license_name"]}
        (license_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("platform", help="manifest platform key: windows-x64 or macos-arm64")
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
