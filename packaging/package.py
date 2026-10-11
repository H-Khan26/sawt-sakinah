"""Zip a PyInstaller build into the release archive.

Windows (a one-folder build): copies LICENSE.txt and THIRD_PARTY_LICENSES.txt into the app
folder and zips it with a single top-level ``SawtSakinah/`` folder.

macOS (``SawtSakinah.app``): the license files are already inside the app (the spec puts
them in ``Contents/Resources`` before PyInstaller signs it), so nothing is added. The zip
is made with ``ditto -c -k --keepParent``, which keeps the symlinks, permissions and
signatures the app needs, with ``SawtSakinah.app`` at the top. The signature is checked
before zipping.

Either way the archive is ``SawtSakinah-<version>-<platform>.zip`` and ``SHA256SUMS`` in
the output directory is rewritten for every zip there.

Usage:
    python packaging/package.py --dist packaging/dist/SawtSakinah [--version 0.1.0] \\
        --platform windows-x64 --notices packaging/build/THIRD_PARTY_LICENSES.txt \\
        --out packaging/dist
    python packaging/package.py --dist packaging/dist/SawtSakinah.app \\
        --platform macos-arm64 --out packaging/dist
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import zipfile
from pathlib import Path
from typing import Optional

REPO = Path(__file__).resolve().parent.parent
TOP = "SawtSakinah"
NOTICES = "THIRD_PARTY_LICENSES.txt"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def app_version() -> str:
    text = (REPO / "sawt_sakinah" / "__init__.py").read_text(encoding="utf-8")
    return re.search(r'^__version__\s*=\s*"([^"]+)"', text, re.M).group(1)


def _check_folder(dist: Path, notices: Optional[Path]) -> None:
    if not (dist / "_internal").is_dir():
        raise SystemExit(f"{dist} is not a PyInstaller one-folder build (no _internal/)")
    if notices is None or not notices.is_file():
        raise SystemExit("--notices must name THIRD_PARTY_LICENSES.txt for a one-folder build")


def _zip_folder(dist: Path, notices: Path, archive: Path) -> None:
    shutil.copyfile(REPO / "LICENSE", dist / "LICENSE.txt")
    shutil.copyfile(notices, dist / NOTICES)
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for root, dirs, files in os.walk(dist):
            dirs.sort()
            for name in sorted(files):
                path = Path(root) / name
                zf.write(path, f"{TOP}/{path.relative_to(dist).as_posix()}")


def _check_app(app: Path) -> None:
    contents = app / "Contents"
    for required in ("Info.plist", f"MacOS/{TOP}", f"Resources/{NOTICES}", "Resources/LICENSE.txt"):
        if not (contents / required).exists():
            raise SystemExit(f"{app} is incomplete: Contents/{required} is missing")
    subprocess.run(  # noqa: S603
        ["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)],
        check=True,
    )


def _zip_app(app: Path, archive: Path) -> None:
    subprocess.run(  # noqa: S603
        ["/usr/bin/ditto", "-c", "-k", "--keepParent", str(app), str(archive)],
        check=True,
    )


def package(
    dist: Path, version: str, platform: str, notices: Optional[Path], out: Path
) -> Path:
    is_app = dist.suffix == ".app"
    # Validate the input before the previous zip of the same name is replaced.
    if is_app:
        _check_app(dist)
    else:
        _check_folder(dist, notices)
    out.mkdir(parents=True, exist_ok=True)
    archive = out / f"{TOP}-{version}-{platform}.zip"
    archive.unlink(missing_ok=True)
    if is_app:
        _zip_app(dist, archive)
    else:
        _zip_folder(dist, notices, archive)

    sums = [f"{_sha256(z)}  {z.name}" for z in sorted(out.glob(f"{TOP}-*.zip"))]
    (out / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8", newline="\n")
    size_mb = archive.stat().st_size / 1e6
    print(f"wrote {archive} ({size_mb:.0f} MB) and {out / 'SHA256SUMS'}")
    return archive


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--dist", type=Path, required=True, help="the COLLECT folder or the .app bundle"
    )
    parser.add_argument("--version", help="default: sawt_sakinah.__version__ (leading v dropped)")
    parser.add_argument("--platform", required=True, help="windows-x64 or macos-arm64")
    parser.add_argument(
        "--notices", type=Path, help="THIRD_PARTY_LICENSES.txt (one-folder builds only)"
    )
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    version = (args.version or app_version()).removeprefix("v")
    package(args.dist, version, args.platform, args.notices, args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
