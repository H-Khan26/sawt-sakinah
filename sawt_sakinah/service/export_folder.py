"""The folder desktop exports are saved to: the user's choice, or their Downloads folder.

In the desktop app (``ServiceSettings.export_to_folder``) a finished render is copied out of
the project into this folder under a readable name and the internal copy is removed. The
saved file belongs to the user from then on: they may rename, move or delete it, and
deleting the recording leaves it in place.

The folder is checked before rendering so a blocked or missing folder fails fast. A copy
lands under a hidden partial name first and is then renamed, so the folder never shows a
half-written file, and an existing file is never overwritten (``name (2).mp3`` instead).
OS errors become messages that say what to do (Windows' Controlled folder access and
macOS' Files and Folders privacy both surface as ``PermissionError``).
"""

from __future__ import annotations

import errno
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional
from uuid import uuid4

from ..applog import open_folder

_log = logging.getLogger(__name__)

# Strip path separators, quotes, and control chars; collapse whitespace to a single dash
# for download names. Keeps unicode (Arabic) intact.
_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]+')
# Keeps a saved file's full path well under Windows' 260-character limit.
_MAX_BASE_LEN = 100
_MAX_COPIES = 999
# Names Windows reserves for devices, with or without an extension.
_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL"} | {f"{p}{i}" for p in ("COM", "LPT") for i in range(1, 10)}
)
# FOLDERID_Downloads.
_DOWNLOADS_GUID = (0x374DE290, 0x123F, 0x4565, (0x91, 0x64, 0x39, 0xC4, 0x92, 0x5E, 0x46, 0x7B))


class ExportFolderError(Exception):
    """The export folder can't be used; the message says why and what to do."""


def safe_base(text: str, *, sep: str = "-") -> str:
    """``text`` as a file name stem: unsafe characters removed, whitespace joined by ``sep``."""
    text = _UNSAFE.sub(" ", text or "")
    text = re.sub(r"\s+", sep, text.strip()).strip(". ")
    text = text[:_MAX_BASE_LEN].rstrip(". ") or "export"
    return f"{text}_" if text.upper() in _RESERVED else text


def _windows_downloads() -> Optional[Path]:
    """The Downloads known folder, which may be redirected (e.g. into OneDrive)."""
    import ctypes
    from ctypes import wintypes

    class _GUID(ctypes.Structure):
        _fields_ = [
            ("Data1", wintypes.DWORD),
            ("Data2", wintypes.WORD),
            ("Data3", wintypes.WORD),
            ("Data4", ctypes.c_ubyte * 8),
        ]

    d1, d2, d3, d4 = _DOWNLOADS_GUID
    guid = _GUID(d1, d2, d3, (ctypes.c_ubyte * 8)(*d4))
    buf = ctypes.c_wchar_p()
    try:
        shell32 = ctypes.windll.shell32  # type: ignore[attr-defined]
        if shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(buf)) != 0:
            return None
        return Path(buf.value) if buf.value else None
    except (OSError, AttributeError):
        return None
    finally:
        if buf:
            ctypes.windll.ole32.CoTaskMemFree(buf)  # type: ignore[attr-defined]


def default_export_dir() -> Path:
    """The user's Downloads folder."""
    if os.name == "nt":
        found = _windows_downloads()
        if found is not None:
            return found
    return Path.home() / "Downloads"


def export_dir(preference: Optional[str]) -> Path:
    """The folder exports go to: the stored preference, or Downloads when unset."""
    return Path(preference) if preference else default_export_dir()


def explain(exc: OSError, folder: Path) -> str:
    """A user-facing message for an OS error while saving to ``folder``."""
    if isinstance(exc, PermissionError):
        if os.name == "nt":
            return (
                f"Windows didn't allow saving to {folder}. If Controlled folder access is on "
                "in Windows Security, allow Sawt Sakinah there, or choose another folder in "
                "Settings."
            )
        if sys.platform == "darwin":
            return (
                f"macOS didn't allow saving to {folder}. Allow Sawt Sakinah under System "
                "Settings › Privacy & Security › Files and Folders, or choose another folder "
                "in Settings."
            )
        return f"You don't have permission to save to {folder}. Choose another folder in Settings."
    if exc.errno == errno.ENOSPC:
        return f"There isn't enough free space to save to {folder}."
    return f"Couldn't save to {folder}: {exc.strerror or exc}"


def check_folder(folder: Path, *, is_default: bool) -> None:
    """Make sure an export can be saved to ``folder``; raises :class:`ExportFolderError`.

    A missing Downloads folder is created; a missing chosen folder is an error, since it may
    sit on a drive that is not plugged in.
    """
    try:
        if is_default:
            folder.mkdir(parents=True, exist_ok=True)
        elif not folder.is_dir():
            raise ExportFolderError(
                f"The export folder {folder} isn't available. Reconnect its drive or choose "
                "another folder in Settings."
            )
        fd, probe = tempfile.mkstemp(prefix=".sawt-", suffix=".tmp", dir=folder)
        os.close(fd)
        os.unlink(probe)
    except OSError as exc:
        raise ExportFolderError(explain(exc, folder)) from exc


def save_copy(src: Path, folder: Path, base: str, ext: str) -> Path:
    """Copy ``src`` into ``folder`` as ``<base>.<ext>`` (or ``<base> (n).<ext>`` when taken)
    and return the saved path. Raises :class:`ExportFolderError`."""
    tmp = folder / f".sawt-{uuid4().hex[:12]}.part"
    try:
        shutil.copyfile(src, tmp)
        for n in range(1, _MAX_COPIES + 1):
            target = folder / (f"{base}.{ext}" if n == 1 else f"{base} ({n}).{ext}")
            if target.exists():
                continue
            try:
                # Windows refuses to rename onto an existing file, which closes the gap
                # between the check and the rename there.
                os.rename(tmp, target)
            except FileExistsError:
                continue
            return target
        raise ExportFolderError(f"{folder} already has too many files named {base}.{ext}.")
    except OSError as exc:
        raise ExportFolderError(explain(exc, folder)) from exc
    finally:
        try:
            tmp.unlink(missing_ok=True)
        except OSError as exc:
            _log.warning("could not remove the partial copy %s: %s", tmp, exc)


def reveal(path: Path) -> None:
    """Show ``path`` selected in the OS file manager (its folder, where that isn't possible)."""
    if os.name == "nt":
        # Explorer parses its own command line; a Windows path can't contain a quote.
        subprocess.Popen(f'explorer /select,"{path}"')  # noqa: S603
    elif sys.platform == "darwin":
        subprocess.Popen(  # noqa: S603
            ["/usr/bin/open", "-R", str(path)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    else:
        open_folder(path.parent)


__all__ = [
    "ExportFolderError",
    "check_folder",
    "default_export_dir",
    "explain",
    "export_dir",
    "reveal",
    "safe_base",
    "save_copy",
]
