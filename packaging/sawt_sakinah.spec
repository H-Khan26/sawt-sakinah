# PyInstaller spec for the Sawt Sakinah desktop bundle (one-folder, windowed).
#
# Inputs, built beforehand:
#   frontend/dist                 the SPA (cd frontend && npm ci && npm run build)
#   packaging/build/vendor/bin    ffmpeg, ffprobe, deno (python packaging/fetch_binaries.py)
# SAWT_SPA_DIR and SAWT_VENDOR_DIR override those locations.
#
# Run from the repo root:
#   pyinstaller --noconfirm --clean --distpath packaging/dist \
#       --workpath packaging/build/pyinstaller packaging/sawt_sakinah.spec
#
# Layout under the bundle root (sys._MEIPASS, i.e. _internal/), as runtime.py expects:
#   frontend/dist/, bin/ffmpeg(.exe), bin/ffprobe(.exe), bin/deno(.exe),
#   sawt_sakinah/config/defaults.yaml, sawt_sakinah/detection/assets/...

import os
import re
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs

REPO = Path(SPECPATH).resolve().parent  # noqa: F821 (PyInstaller global)
PACKAGE = REPO / "sawt_sakinah"
IS_WIN = sys.platform == "win32"
EXE_SUFFIX = ".exe" if IS_WIN else ""

spa_dir = Path(os.environ.get("SAWT_SPA_DIR") or REPO / "frontend" / "dist").resolve()
vendor_dir = Path(os.environ.get("SAWT_VENDOR_DIR") or REPO / "packaging" / "build" / "vendor")
vendor_dir = vendor_dir.resolve()


def _fail(message):
    raise SystemExit(f"\nsawt_sakinah.spec: {message}\n")


if not (spa_dir / "index.html").is_file():
    _fail(
        f"the built SPA is missing ({spa_dir / 'index.html'}).\n"
        "Build it first: cd frontend && npm ci && npm run build"
    )

tool_binaries = []
for tool in ("ffmpeg", "ffprobe", "deno"):
    path = vendor_dir / "bin" / f"{tool}{EXE_SUFFIX}"
    if not path.is_file():
        _fail(
            f"{path} is missing.\n"
            f"Fetch the helper programs first: python packaging/fetch_binaries.py "
            f"{'windows-x64' if IS_WIN else '<platform>'} {vendor_dir}"
        )
    tool_binaries.append((str(path), "bin"))

version = re.search(
    r'^__version__\s*=\s*"([^"]+)"', (PACKAGE / "__init__.py").read_text(encoding="utf-8"), re.M
).group(1)


def _package_tree():
    """Every sawt_sakinah module name, plus its non-Python files as (src, dest) datas."""
    modules, datas = [], []
    for path in sorted(PACKAGE.rglob("*")):
        if "__pycache__" in path.parts or not path.is_file():
            continue
        rel = path.relative_to(REPO)
        if path.suffix == ".py":
            parts = list(rel.with_suffix("").parts)
            if parts[-1] == "__init__":
                parts.pop()
            modules.append(".".join(parts))
        elif path.suffix not in (".pyc", ".pyo"):
            datas.append((str(path), str(rel.parent)))
    return modules, datas


app_modules, app_datas = _package_tree()

datas = [(str(spa_dir), "frontend/dist")]
datas += app_datas
datas += collect_data_files("faster_whisper")  # assets/silero_vad_v6.onnx
datas += collect_data_files("yt_dlp_ejs")  # challenge-solver scripts used with Deno

binaries = list(tool_binaries)
binaries += collect_dynamic_libs("ctranslate2")  # loaded by glob at import time

hiddenimports = list(app_modules)
if IS_WIN:
    hiddenimports += ["webview.platforms.winforms", "webview.platforms.edgechromium"]

excludes = [
    "mutagen",  # GPL; yt-dlp only needs it for thumbnail embedding, which the app never does
    # huggingface_hub detects hf_xet by its dist-info, which is not collected, so the
    # frozen app never imports it; downloads use plain HTTPS.
    "hf_xet",
    "tkinter",
    "_tkinter",
    "matplotlib",
    "IPython",
    "pytest",
    "torch",
    "transformers",
    "tensorflow",
]

a = Analysis(  # noqa: F821
    [str(REPO / "packaging" / "entry.py")],
    pathex=[str(REPO)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=excludes,
    noarchive=False,
)
pyz = PYZ(a.pure)  # noqa: F821

version_file = None
if IS_WIN:
    from PyInstaller.utils.win32 import versioninfo as vi

    nums = tuple(int(n) for n in re.findall(r"\d+", version)[:3]) + (0,) * 4
    nums = nums[:4]
    info = vi.VSVersionInfo(
        ffi=vi.FixedFileInfo(filevers=nums, prodvers=nums),
        kids=[
            vi.StringFileInfo([
                vi.StringTable("040904B0", [
                    vi.StringStruct("ProductName", "Sawt Sakinah"),
                    vi.StringStruct("FileDescription", "Sawt Sakinah"),
                    vi.StringStruct("FileVersion", version),
                    vi.StringStruct("ProductVersion", version),
                    vi.StringStruct("OriginalFilename", "SawtSakinah.exe"),
                    vi.StringStruct("LegalCopyright", "MIT License"),
                ])
            ]),
            vi.VarFileInfo([vi.VarStruct("Translation", [0x0409, 1200])]),
        ],
    )
    version_file = Path(workpath) / "version_info.txt"  # noqa: F821
    version_file.parent.mkdir(parents=True, exist_ok=True)
    version_file.write_text(str(info), encoding="utf-8")

exe = EXE(  # noqa: F821
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="SawtSakinah",
    console=False,
    disable_windowed_traceback=False,
    icon=str(REPO / "packaging" / "sawt_sakinah.ico"),
    version=str(version_file) if version_file else None,
    upx=False,
)
coll = COLLECT(  # noqa: F821
    exe,
    a.binaries,
    a.datas,
    name="SawtSakinah",
    upx=False,
)
