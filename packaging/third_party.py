"""Generate THIRD_PARTY_LICENSES.txt for the desktop bundle.

Two steps, because the SPA and the Python bundle are built on different machines:

``frontend``  reads ``frontend/package-lock.json`` and ``frontend/node_modules`` and writes
              the licenses of the npm packages that ship in the built SPA (runtime
              dependencies only, not the dev toolchain).

``bundle``    runs in the Python environment the bundle was frozen from and writes the full
              notice file: Sawt Sakinah itself, Python, every package pinned in the lock file
              (license metadata plus the license files from its dist-info), the PyInstaller
              bootloader, the helper programs fetched by fetch_binaries.py (FFmpeg, Deno),
              the vendored Silero VAD model, the Whisper model downloaded at runtime, the
              SPA's webfonts and, when given, the ``frontend`` output.

Usage:
    python packaging/third_party.py frontend frontend -o packaging/build/frontend-licenses.txt
    python packaging/third_party.py bundle --lock packaging/requirements-windows.txt \\
        --vendor packaging/build/vendor --spa frontend/dist \\
        --frontend-notices packaging/build/frontend-licenses.txt -o THIRD_PARTY_LICENSES.txt
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from importlib import metadata
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
RULE = "=" * 79
LICENSE_NAME = re.compile(r"^(licen[cs]e|copying|notice|authors)", re.I)
# Packages whose metadata label misdescribes what the bundle actually contains.
LICENSE_OVERRIDES = {
    "pyinstaller": "GPL-2.0-or-later WITH Bootloader-exception (only the bootloader ships)",
}

STATIC_NOTICES = [
    (
        "Whisper speech model (downloaded at runtime, not bundled)",
        "MIT",
        "Sawt Sakinah downloads a CTranslate2 conversion of OpenAI's Whisper model from the\n"
        "Hugging Face Hub the first time phrase detection runs (for example\n"
        "https://huggingface.co/Systran/faster-whisper-large-v3). The Whisper weights are\n"
        "released by OpenAI under the MIT License: https://github.com/openai/whisper/blob/main/LICENSE",
    ),
    (
        "PyInstaller bootloader",
        "GPL-2.0-or-later WITH Bootloader-exception",
        "SawtSakinah.exe starts through the PyInstaller bootloader. Its license (GPL v2 or\n"
        "later with the bootloader exception) allows distributing it with programs under any\n"
        "license. https://github.com/pyinstaller/pyinstaller/blob/develop/COPYING.txt",
    ),
    (
        "FFmpeg libraries inside PyAV (av.libs)",
        "LGPL-2.1-or-later",
        "The PyAV wheel ships its own FFmpeg shared libraries (_internal/av.libs), built\n"
        "under the LGPL. Sources: https://github.com/PyAV-Org/PyAV and\n"
        "https://github.com/PyAV-Org/pyav-ffmpeg (build scripts and FFmpeg sources).",
    ),
]


def _section(title: str, body: str) -> str:
    return f"{RULE}\n{title}\n{RULE}\n\n{body.rstrip()}\n\n"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


# -- Python packages --------------------------------------------------------------------


def _lock_names(lock: Path) -> list[str]:
    names = []
    for line in _read(lock).splitlines():
        match = re.match(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==", line)
        if match:
            names.append(match.group(1))
    return sorted(set(names), key=str.lower)


def _dist_license(dist: metadata.Distribution) -> str:
    meta = dist.metadata
    expr = meta.get("License-Expression")
    if expr:
        return expr
    text = (meta.get("License") or "").strip()
    if text and "\n" not in text and len(text) < 100:
        return text
    classifiers = [
        c.split("::")[-1].strip()
        for c in meta.get_all("Classifier") or []
        if c.startswith("License ::")
    ]
    if classifiers:
        return "; ".join(classifiers)
    for _, body in _dist_license_texts(dist):
        first = next((ln.strip() for ln in body.splitlines() if ln.strip()), "")
        if first and len(first) < 60:
            return first  # e.g. "MIT License"
    return "see license text below" if text else "UNKNOWN"


def _dist_license_texts(dist: metadata.Distribution) -> list[tuple[str, str]]:
    """(name, text) of each license file shipped in the distribution's metadata."""
    texts = []
    seen = set()
    for rel in dist.metadata.get_all("License-File") or []:
        for candidate in (f"licenses/{rel}", rel):
            text = dist.read_text(candidate)
            if text is not None:
                texts.append((rel, text))
                seen.add(Path(rel).name.lower())
                break
    for file in dist.files or []:
        parts = Path(str(file)).parts
        if not parts or not parts[0].endswith(".dist-info"):
            continue
        name = parts[-1]
        if name.lower() in seen or not LICENSE_NAME.match(name) or name.endswith((".py", ".pyc")):
            continue
        try:
            text = Path(file.locate()).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        texts.append(("/".join(parts[1:]), text))
        seen.add(name.lower())
    if not texts:
        body = (dist.metadata.get("License") or "").strip()
        if "\n" in body or len(body) >= 100:
            texts.append(("License (from package metadata)", body))
    return texts


def _python_section() -> str:
    version = ".".join(map(str, sys.version_info[:3]))
    lic = Path(sys.base_prefix) / "LICENSE.txt"
    body = f"Python {version}, Python Software Foundation License.\nhttps://www.python.org/\n"
    if lic.is_file():
        body += "\n" + _read(lic)
    return _section(f"Python {version} -- PSF-2.0", body)


def _package_sections(names: list[str]) -> tuple[list[str], list[str]]:
    summary, sections = [], []
    for name in names:
        try:
            dist = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            raise SystemExit(f"{name} (from the lock file) is not installed in this environment")
        meta = dist.metadata
        lic = LICENSE_OVERRIDES.get(name.lower()) or _dist_license(dist)
        url = meta.get("Home-page") or ""
        if not url:
            for entry in meta.get_all("Project-URL") or []:
                label, _, link = entry.partition(",")
                if label.strip().lower() in ("homepage", "home", "source", "repository"):
                    url = link.strip()
                    break
        summary.append(f"  {meta['Name']} {dist.version}  [{lic}]")
        body = f"{meta['Name']} {dist.version}\nLicense: {lic}\n"
        if url:
            body += f"Homepage: {url}\n"
        for file_name, text in _dist_license_texts(dist):
            body += f"\n--- {file_name} ---\n\n{text.rstrip()}\n"
        sections.append(_section(f"{meta['Name']} {dist.version} -- {lic}", body))
    return summary, sections


# -- other components -------------------------------------------------------------------


def _vendor_sections(vendor: Path) -> tuple[list[str], list[str]]:
    summary, sections = [], []
    root = vendor / "THIRD_PARTY"
    if not root.is_dir():
        raise SystemExit(f"{root} is missing; run fetch_binaries.py first")
    for tool_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        meta = json.loads(_read(tool_dir / "meta.json"))
        summary.append(f"  {meta['name']} {meta['version']}  [{meta['license']}]  (bin/)")
        body = _read(tool_dir / "SOURCE.txt")
        for path in sorted(tool_dir.iterdir()):
            if path.name not in ("SOURCE.txt", "meta.json"):
                body += f"\n--- {path.name} ---\n\n{_read(path).rstrip()}\n"
        sections.append(_section(f"{meta['name']} {meta['version']} -- {meta['license']}", body))
    return summary, sections


def _font_sections(spa: Path) -> tuple[list[str], list[str]]:
    summary, sections = [], []
    for path in sorted((spa / "fonts").glob("*-OFL.txt")):
        family = path.name[: -len("-OFL.txt")]
        summary.append(f"  {family} webfont  [OFL-1.1]")
        sections.append(_section(f"{family} webfont -- OFL-1.1", _read(path)))
    return summary, sections


def build_bundle_notices(lock: Path, vendor: Path, spa: Path, frontend: Path | None) -> str:
    from_repo = _read(REPO / "LICENSE")
    silero = _read(REPO / "sawt_sakinah" / "detection" / "assets" / "SILERO_LICENSE")

    py_summary, py_sections = _package_sections(_lock_names(lock) + ["pyinstaller"])
    tool_summary, tool_sections = _vendor_sections(vendor)
    font_summary, font_sections = _font_sections(spa)

    out = [
        "Sawt Sakinah -- third-party notices\n\n"
        "Sawt Sakinah is MIT licensed (LICENSE.txt next to this file). This folder also\n"
        "contains the third-party software listed below, each under its own license.\n\n",
        "Helper programs:\n" + "\n".join(tool_summary) + "\n\n",
        "Python runtime and packages:\n"
        f"  Python {'.'.join(map(str, sys.version_info[:3]))}  [PSF-2.0]\n"
        + "\n".join(py_summary)
        + "\n\n",
        "Models and assets:\n  Silero VAD model  [MIT]\n  Whisper model (downloaded at runtime)  [MIT]\n"
        + "\n".join(font_summary)
        + "\n\n",
    ]
    if frontend is not None:
        out.append("Web interface packages: listed in the 'Web interface' section below.\n\n")
    out.append(_section("Sawt Sakinah -- MIT", from_repo))
    out.extend(tool_sections)
    out.append(_python_section())
    out.extend(py_sections)
    out.append(_section("Silero VAD model (sawt_sakinah/detection/assets) -- MIT", silero))
    for title, lic, body in STATIC_NOTICES:
        out.append(_section(f"{title} -- {lic}", body))
    out.extend(font_sections)
    if frontend is not None:
        out.append(_section("Web interface (npm packages compiled into the SPA)", _read(frontend)))
    return "".join(out)


# -- frontend ---------------------------------------------------------------------------


def build_frontend_notices(frontend_dir: Path) -> str:
    lock = json.loads(_read(frontend_dir / "package-lock.json"))
    out = []
    for key, info in sorted(lock.get("packages", {}).items()):
        if not key or info.get("dev") or info.get("devOptional"):
            continue
        pkg_dir = frontend_dir / key
        manifest = pkg_dir / "package.json"
        if not manifest.is_file():
            raise SystemExit(f"{manifest} is missing; run npm ci first")
        pkg = json.loads(_read(manifest))
        lic = pkg.get("license") or info.get("license") or "UNKNOWN"
        name = pkg.get("name") or key.split("node_modules/")[-1]
        body = f"{name} {pkg.get('version', '')}\nLicense: {lic}\n"
        for path in sorted(pkg_dir.iterdir()):
            if path.is_file() and LICENSE_NAME.match(path.name):
                body += f"\n--- {path.name} ---\n\n{_read(path).rstrip()}\n"
        out.append(f"{'-' * 79}\n{name} {pkg.get('version', '')} -- {lic}\n{'-' * 79}\n\n{body}\n")
    return "".join(out)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)

    fe = sub.add_parser("frontend", help="licenses of the npm packages in the SPA")
    fe.add_argument("frontend_dir", type=Path)
    fe.add_argument("-o", "--out", type=Path, required=True)

    bundle = sub.add_parser("bundle", help="the full THIRD_PARTY_LICENSES.txt")
    bundle.add_argument("--lock", type=Path, required=True)
    bundle.add_argument("--vendor", type=Path, required=True)
    bundle.add_argument("--spa", type=Path, required=True)
    bundle.add_argument("--frontend-notices", type=Path)
    bundle.add_argument("-o", "--out", type=Path, required=True)

    args = parser.parse_args(argv)
    if args.command == "frontend":
        text = build_frontend_notices(args.frontend_dir)
    else:
        text = build_bundle_notices(args.lock, args.vendor, args.spa, args.frontend_notices)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {args.out} ({len(text) // 1024} KiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
