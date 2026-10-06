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
    ``sawt_sakinah`` location in a source checkout."""
    if FROZEN:
        from platformdirs import user_data_dir

        return Path(user_data_dir(APP_NAME, appauthor=False))
    return _legacy_data_root()


def config_dir() -> Path:
    """Per-user config directory (holds ``config.yaml`` overrides and preferences)."""
    if FROZEN:
        from platformdirs import user_config_dir

        return Path(user_config_dir(APP_NAME, appauthor=False))
    return _legacy_data_root()


def projects_dir() -> Path:
    return data_dir() / "projects"


def cache_dir() -> Path:
    if FROZEN or os.environ.get("LOCALAPPDATA"):
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
