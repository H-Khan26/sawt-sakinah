"""Where the app's files live, in a source checkout and in the frozen desktop bundle.

The bundle (a PyInstaller one-folder build) is read-only. It holds the code, the built SPA
(``frontend/dist``), the config defaults and the ffmpeg / ffprobe / Deno binaries under
``bin/``. Everything the app writes goes to per-user directories outside it, so replacing
the app folder with a newer release loses nothing.

This is the only module that knows that layout. Every other module asks it for paths and
helper programs instead of guessing from ``PATH``, the working directory or its own file
location, and passes absolute paths down to the detection and editing layers.

In a source checkout the bundle root is the repo, helper programs come from ``PATH`` and
the data directories keep their pre-bundle locations, so the dev workflow is unchanged.

``--data-dir <absolute path>`` on the process's command line (or :func:`set_data_dir`)
moves every per-user directory (data, logs, cache, models, config) under that path for
this process. It is read when this module is imported, before the config loads, so it
also covers ``config.yaml``. CI uses it to give the self-test a known log location.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path
from typing import Optional

APP_NAME = "SawtSakinah"

#: True inside the PyInstaller bundle.
FROZEN: bool = bool(getattr(sys, "frozen", False))

#: Helper programs the bundle ships under ``bin/``.
TOOLS = ("ffmpeg", "ffprobe", "deno")

_EXE_SUFFIX = ".exe" if os.name == "nt" else ""
_PACKAGE_DIR = Path(__file__).resolve().parent


class ToolNotFoundError(FileNotFoundError):
    """A helper program (ffmpeg, ffprobe, Deno) could not be found."""


DATA_DIR_OPTION = "--data-dir"
_DATA_DIR_OVERRIDE: Optional[Path] = None


def data_dir_from_argv(argv: list[str]) -> Optional[Path]:
    """The ``--data-dir`` value in ``argv`` when it is an absolute path, else ``None``."""
    value: Optional[str] = None
    for i, arg in enumerate(argv):
        if arg == "--":
            break
        if arg == DATA_DIR_OPTION and i + 1 < len(argv):
            value = argv[i + 1]
        elif arg.startswith(DATA_DIR_OPTION + "="):
            value = arg.split("=", 1)[1]
    return Path(value) if value and Path(value).is_absolute() else None


def set_data_dir(path: str | os.PathLike) -> Path:
    """Keep all per-user data, logs, cache, models and config under ``path`` (absolute;
    created if missing) for the rest of this process."""
    global _DATA_DIR_OVERRIDE
    target = Path(path)
    if not target.is_absolute():
        raise ValueError(f"the data directory must be an absolute path: {path}")
    target.mkdir(parents=True, exist_ok=True)
    _DATA_DIR_OVERRIDE = target
    return target


# -- bundle (read-only) -----------------------------------------------------------------


def bundle_root() -> Path:
    """The read-only root: the unpacked bundle when frozen, else the repo checkout."""
    if FROZEN:
        return Path(getattr(sys, "_MEIPASS", Path(sys.executable).resolve().parent))
    return _PACKAGE_DIR.parent


def static_dir() -> Path:
    """The built SPA directory (``frontend/dist`` under the bundle root)."""
    return bundle_root() / "frontend" / "dist"


def bundled_tool(name: str) -> Optional[Path]:
    """``bin/<name>`` under the bundle root, when it exists."""
    path = bundle_root() / "bin" / f"{name}{_EXE_SUFFIX}"
    return path if path.is_file() else None


# -- user data (writable) ---------------------------------------------------------------


def _legacy_data_root() -> Path:
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "sawt_sakinah"
    return Path.home() / ".local" / "share" / "sawt_sakinah"


def data_dir() -> Path:
    """Per-user data root: ``%LOCALAPPDATA%\\SawtSakinah`` on Windows and
    ``~/Library/Application Support/SawtSakinah`` on macOS when frozen; the pre-bundle
    ``sawt_sakinah`` location in a source checkout; the ``--data-dir`` path when given."""
    if _DATA_DIR_OVERRIDE is not None:
        return _DATA_DIR_OVERRIDE
    if FROZEN:
        from platformdirs import user_data_dir

        return Path(user_data_dir(APP_NAME, appauthor=False))
    return _legacy_data_root()


def config_dir() -> Path:
    """Per-user config directory (holds ``config.yaml`` overrides and preferences)."""
    if _DATA_DIR_OVERRIDE is not None:
        return _DATA_DIR_OVERRIDE
    if FROZEN:
        from platformdirs import user_config_dir

        return Path(user_config_dir(APP_NAME, appauthor=False))
    return _legacy_data_root()


def projects_dir() -> Path:
    return data_dir() / "projects"


def cache_dir() -> Path:
    if _DATA_DIR_OVERRIDE is not None or FROZEN or os.environ.get("LOCALAPPDATA"):
        return data_dir() / "cache"
    return Path.home() / ".cache" / "sawt_sakinah"


def models_dir() -> Path:
    return data_dir() / "models"


def logs_dir() -> Path:
    return data_dir() / "logs"


def user_config_file() -> Path:
    """Optional per-user overrides of ``defaults.yaml``."""
    return config_dir() / "config.yaml"


# -- helper programs --------------------------------------------------------------------


def _not_found(name: str) -> ToolNotFoundError:
    if FROZEN:
        return ToolNotFoundError(
            f"The app's copy of {name} is missing. Download the app again and replace "
            "the whole folder."
        )
    hint = "Install Deno" if name == "deno" else "Install FFmpeg (it includes ffprobe)"
    return ToolNotFoundError(f"'{name}' was not found on PATH. {hint}.")


def tool_path(name: str) -> str:
    """Absolute path of a helper program: the bundled copy, else ``PATH`` (source only).

    The bundle never searches ``PATH``, so a stray ``ffmpeg.exe`` in the user's
    Downloads folder can't stand in for the bundled one.
    """
    bundled = bundled_tool(name)
    if bundled is not None:
        return str(bundled)
    if not FROZEN:
        found = shutil.which(name)
        if found:
            return str(Path(found).resolve())
    raise _not_found(name)


def resolve_executable(program: str | os.PathLike) -> str:
    """Absolute path for ``program``.

    A bare tool name (``"ffmpeg"``, ``"ffprobe.exe"``) resolves through :func:`tool_path`.
    An explicit path must exist. Any other bare name is looked up on ``PATH`` in a source
    checkout only.
    """
    text = os.fspath(program)
    name = Path(text).name
    stem = name[: -len(".exe")] if name.lower().endswith(".exe") else name
    if text == name and stem in TOOLS:
        return tool_path(stem)
    if os.path.isabs(text):
        if Path(text).is_file():
            return text
        raise ToolNotFoundError(f"'{text}' does not exist.")
    if text != name:
        raise ToolNotFoundError(f"'{text}' must be an absolute path or a bare program name.")
    if not FROZEN:
        found = shutil.which(text)
        if found:
            return str(Path(found).resolve())
    raise _not_found(text)


__all__ = [
    "APP_NAME",
    "FROZEN",
    "TOOLS",
    "ToolNotFoundError",
    "bundle_root",
    "static_dir",
    "bundled_tool",
    "data_dir",
    "config_dir",
    "projects_dir",
    "cache_dir",
    "models_dir",
    "logs_dir",
    "user_config_file",
    "tool_path",
    "resolve_executable",
]


# Applied at import, before the config loads. A path that can't be created is left to the
# desktop command's own argument check, which reports it.
_ARGV_DATA_DIR = data_dir_from_argv(sys.argv[1:])
if _ARGV_DATA_DIR is not None:
    try:
        set_data_dir(_ARGV_DATA_DIR)
    except OSError:
        pass
