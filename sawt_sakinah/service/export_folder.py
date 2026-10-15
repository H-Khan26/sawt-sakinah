"""The folder desktop exports are saved to: the user's choice, or their Downloads folder.

In the desktop app (``ServiceSettings.export_to_folder``) a finished render is moved out of
the project into this folder under a readable name. The saved file belongs to the user from
then on: they may rename, move or delete it, and deleting the recording leaves it in place.

The folder is checked before rendering so a blocked or missing folder fails fast. A render
is renamed into the folder when it is on the same drive and copied otherwise; either way it
lands under a hidden partial name first, so the folder never shows a half-written file, and
an existing file is never replaced (``name (2).mp3`` instead). When saving fails the render
is put back, so nothing is lost. OS errors become messages that say what to do (Windows'
Controlled folder access and macOS' Files and Folders privacy both surface as
``PermissionError``).
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
from ..fileio import retry_locked
from .preferences import load_preferences

_log = logging.getLogger(__name__)

# Strip path separators, quotes, and control chars; collapse whitespace to a single dash
# for download names. Keeps unicode (Arabic) intact.
_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]+')
_MAX_BASE_LEN = 100
_MAX_COPIES = 999
# Windows' path limit (MAX_PATH less the terminator), and the shortest name an export
# folder must leave room for.
_MAX_WIN_PATH = 259
_MIN_NAME = 24
# Names Windows reserves for devices, whatever follows the first dot.
_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL"} | {f"{p}{i}" for p in ("COM", "LPT") for i in range(1, 10)}
)
# FOLDERID_Downloads.
_DOWNLOADS_GUID = (0x374DE290, 0x123F, 0x4565, (0x91, 0x64, 0x39, 0xC4, 0x92, 0x5E, 0x46, 0x7B))
_FILE_ATTRIBUTE_HIDDEN = 0x2


class ExportFolderError(Exception):
    """The export folder can't be used; the message says why and what to do."""


def safe_base(text: str, *, sep: str = "-") -> str:
    """``text`` as a file name stem: unsafe characters removed, whitespace joined by ``sep``."""
    text = _UNSAFE.sub(" ", text or "")
    text = re.sub(r"\s+", sep, text.strip()).strip(". ")
    text = text[:_MAX_BASE_LEN].rstrip(". ") or "export"
    head, dot, tail = text.partition(".")
    return f"{head}_{dot}{tail}" if head.rstrip().upper() in _RESERVED else text


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
    if os.name == "nt" and len(str(folder)) > _MAX_WIN_PATH - _MIN_NAME:
        raise ExportFolderError(
            f"The path of {folder} is too long to save into. Choose a shorter folder in Settings."
        )
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


def checked_export_dir() -> Path:
    """The export folder from the preferences, checked with :func:`check_folder`."""
    chosen = load_preferences().export_dir
    folder = export_dir(chosen)
    check_folder(folder, is_default=chosen is None)
    return folder


def _fit(base: str, folder: Path, ext: str) -> str:
    """Shorten ``base`` so the longest name it can get fits Windows' path limit."""
    if os.name != "nt":
        return base
    room = _MAX_WIN_PATH - len(str(folder / f" ({_MAX_COPIES}).{ext}"))
    return base[: max(room, 1)].rstrip(". ") or "export"


def _set_hidden(path: Path, hidden: bool) -> None:
    """Hide or unhide ``path`` in Explorer (Windows; elsewhere the leading dot hides it)."""
    if os.name != "nt":
        return
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    kernel32.GetFileAttributesW.restype = wintypes.DWORD
    attrs = kernel32.GetFileAttributesW(str(path))
    if attrs == 0xFFFFFFFF:  # INVALID_FILE_ATTRIBUTES
        return
    flags = attrs | _FILE_ATTRIBUTE_HIDDEN if hidden else attrs & ~_FILE_ATTRIBUTE_HIDDEN
    kernel32.SetFileAttributesW(str(path), flags)


def _place(tmp: Path, target: Path) -> None:
    """Rename ``tmp`` to ``target``, raising ``FileExistsError`` instead of replacing a file."""
    if os.name == "nt":
        os.rename(tmp, target)  # Windows never renames onto an existing file
        return
    try:
        os.link(tmp, target)  # fails when target exists
    except FileExistsError:
        raise
    except OSError:
        # No hard links on this filesystem (exFAT, some shares): the caller's exists()
        # check is the only guard left.
        os.rename(tmp, target)
        return
    os.unlink(tmp)


def _claim(tmp: Path, folder: Path, base: str, ext: str) -> Path:
    for n in range(1, _MAX_COPIES + 1):
        target = folder / (f"{base}.{ext}" if n == 1 else f"{base} ({n}).{ext}")
        if target.exists():
            continue
        try:
            _place(tmp, target)
        except FileExistsError:
            continue
        return target
    raise ExportFolderError(f"{folder} already has too many files named {base}.{ext}.")


def save_render(src: Path, folder: Path, name: str, ext: str) -> Path:
    """Move the render ``src`` into ``folder`` as ``<name>.<ext>`` (``<name> (n).<ext>`` when
    taken) and return the saved path.

    Raises :class:`ExportFolderError`, leaving ``src`` where it was.
    """
    base = _fit(safe_base(name, sep=" "), folder, ext)
    tmp = folder / f".sawt-{uuid4().hex[:12]}.part"
    moved = False
    try:
        try:
            os.rename(src, tmp)  # instant on the same drive
            moved = True
        except OSError:
            shutil.copyfile(src, tmp)
        _set_hidden(tmp, True)
        target = _claim(tmp, folder, base, ext)
        _set_hidden(target, False)
    except (OSError, ExportFolderError) as exc:
        if moved:
            _put_back(tmp, src)
        else:
            _remove(tmp, "partial copy")
        if isinstance(exc, ExportFolderError):
            raise
        raise ExportFolderError(explain(exc, folder)) from exc
    if not moved:
        _remove(src, "rendered export")
    return target


def _put_back(tmp: Path, src: Path) -> None:
    try:
        os.rename(tmp, src)
    except OSError as exc:
        _log.error("could not move the render back from %s to %s: %s", tmp, src, exc)


def _remove(path: Path, what: str) -> None:
    try:
        retry_locked(lambda: path.unlink(missing_ok=True))
    except OSError as exc:
        _log.warning("could not remove the %s %s: %s", what, path, exc)


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
    "checked_export_dir",
    "default_export_dir",
    "explain",
    "export_dir",
    "reveal",
    "safe_base",
    "save_render",
]
