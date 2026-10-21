"""Per-user app preferences, stored as JSON in the user config directory.

The desktop window's origin changes with its port, so preferences the UI used to keep in
``localStorage`` live here instead, next to the app-level choices (update check, sign-in
cookies). Reads tolerate a missing or corrupt file, and fall back to the
default for any single value that is no longer valid, and ignore keys they don't know;
writes are atomic.

Sign-in cookies are either a browser to read them from (``cookies_browser``, one of
``schemas.COOKIE_BROWSERS``) or a cookies.txt file (``cookies_file``, an absolute path that
must exist when it is set); at most one is set. Only the choice is stored here: the
cookies stay where they are and are read on each link import.

``export_dir`` is the folder desktop exports are saved to; ``None`` means the Downloads
folder (see ``export_folder.py``). A stored folder that went missing stays set, and the
next export says so.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator, model_validator

from .. import runtime
from ..config import CONFIG
from ..fileio import replace_file
from .schemas import (
    SILENCE_DETECTORS,
    check_cookie_browser,
    check_cookies_file,
    check_export_dir,
)

_LOCK = threading.Lock()
_NULLABLE = frozenset({"dismissed_update", "cookies_browser", "cookies_file", "export_dir"})
_MAX_VERSION_LEN = 64
THEMES = frozenset({"system", "day", "night"})
LIBRARY_VIEWS = frozenset({"icons", "list"})


def _check_silence_detector(value: str) -> str:
    if value not in SILENCE_DETECTORS:
        allowed = ", ".join(sorted(SILENCE_DETECTORS))
        raise ValueError(f"silence_detector must be one of: {allowed}")
    return value


def _check_color_theme(value: str) -> str:
    if value not in THEMES:
        raise ValueError(f"theme must be one of: {', '.join(sorted(THEMES))}")
    return value


def _check_library_view(value: str) -> str:
    if value not in LIBRARY_VIEWS:
        raise ValueError(f"library_view must be one of: {', '.join(sorted(LIBRARY_VIEWS))}")
    return value


def _check_version(value: Optional[str]) -> Optional[str]:
    if value is not None and len(value) > _MAX_VERSION_LEN:
        raise ValueError("dismissed_update is too long")
    return value


class Preferences(BaseModel):
    """Everything the user can change from the UI that isn't project data."""

    update_check: bool = True
    dismissed_update: Optional[str] = None
    show_deleted: bool = False
    silence_detector: str = CONFIG.silence.detector
    cookies_browser: Optional[str] = None
    cookies_file: Optional[str] = None
    ytdlp_update: bool = False  # opt-in yt-dlp self-update (ytdlp_updates.py)
    theme: str = "system"  # "system" follows the OS colour scheme
    landing: bool = True  # open on the dome landing at launch
    library_view: str = "icons"
    export_dir: Optional[str] = None  # None saves exports to Downloads
    surah_view: bool = True  # tint the recognised surahs on the waveform
    show_fatihah: bool = True  # include Al-Fatihah in the surah band and list
    snap_edges: bool = True  # latch waveform clicks and drags on to nearby edges

    @field_validator("cookies_browser")
    @classmethod
    def _check_browser(cls, v: Optional[str]) -> Optional[str]:
        return v if v is None else check_cookie_browser(v)

    @field_validator("cookies_file")
    @classmethod
    def _check_file(cls, v: Optional[str]) -> Optional[str]:
        # A stored file that went missing stays set; the import then says so.
        return v if v is None else check_cookies_file(v, must_exist=False)

    @field_validator("export_dir")
    @classmethod
    def _check_export_dir(cls, v: Optional[str]) -> Optional[str]:
        return v if v is None else check_export_dir(v, must_exist=False)

    @model_validator(mode="after")
    def _one_cookie_source(self) -> "Preferences":
        if self.cookies_browser is not None and self.cookies_file is not None:
            raise ValueError("set cookies_browser or cookies_file, not both")
        return self

    @field_validator("silence_detector")
    @classmethod
    def _check_detector(cls, v: str) -> str:
        return _check_silence_detector(v)

    @field_validator("dismissed_update")
    @classmethod
    def _check_dismissed(cls, v: Optional[str]) -> Optional[str]:
        return _check_version(v)

    @field_validator("theme")
    @classmethod
    def _check_theme(cls, v: str) -> str:
        return _check_color_theme(v)

    @field_validator("library_view")
    @classmethod
    def _check_view(cls, v: str) -> str:
        return _check_library_view(v)


class PreferencesPatch(BaseModel):
    """Body of ``PATCH /app/preferences``: any subset of :class:`Preferences`.

    Unknown keys are rejected, and only the keys in ``_NULLABLE`` may be set to ``null``.
    """

    model_config = ConfigDict(extra="forbid")

    update_check: Optional[bool] = None
    dismissed_update: Optional[str] = None
    show_deleted: Optional[bool] = None
    silence_detector: Optional[str] = None
    cookies_browser: Optional[str] = None
    cookies_file: Optional[str] = None
    ytdlp_update: Optional[bool] = None
    theme: Optional[str] = None
    landing: Optional[bool] = None
    library_view: Optional[str] = None
    export_dir: Optional[str] = None
    surah_view: Optional[bool] = None
    show_fatihah: Optional[bool] = None
    snap_edges: Optional[bool] = None

    @field_validator("cookies_browser")
    @classmethod
    def _check_browser(cls, v: Optional[str]) -> Optional[str]:
        return v if v is None else check_cookie_browser(v)

    @field_validator("cookies_file")
    @classmethod
    def _check_file(cls, v: Optional[str]) -> Optional[str]:
        return v if v is None else check_cookies_file(v)

    @field_validator("export_dir")
    @classmethod
    def _check_export_dir(cls, v: Optional[str]) -> Optional[str]:
        return v if v is None else check_export_dir(v)

    @field_validator("silence_detector")
    @classmethod
    def _check_detector(cls, v: Optional[str]) -> Optional[str]:
        return v if v is None else _check_silence_detector(v)

    @field_validator("dismissed_update")
    @classmethod
    def _check_dismissed(cls, v: Optional[str]) -> Optional[str]:
        return _check_version(v)

    @field_validator("theme")
    @classmethod
    def _check_theme(cls, v: Optional[str]) -> Optional[str]:
        return v if v is None else _check_color_theme(v)

    @field_validator("library_view")
    @classmethod
    def _check_view(cls, v: Optional[str]) -> Optional[str]:
        return v if v is None else _check_library_view(v)

    @model_validator(mode="after")
    def _no_nulls(self) -> "PreferencesPatch":
        for key in self.model_fields_set - _NULLABLE:
            if getattr(self, key) is None:
                raise ValueError(f"{key} must not be null")
        return self

    def changes(self) -> dict:
        """Only the keys the client sent."""
        return self.model_dump(include=self.model_fields_set)


def preferences_path() -> Path:
    return runtime.config_dir() / "preferences.json"


def load_preferences(path: Optional[Path] = None) -> Preferences:
    # Under the lock: on Windows an open reader would make a concurrent write's replace fail.
    with _LOCK:
        return _load(path or preferences_path())


def _load(src: Path) -> Preferences:
    try:
        raw = json.loads(src.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return Preferences()
    if not isinstance(raw, dict):
        return Preferences()
    # Keep every value that is still valid on its own; drop the rest to their defaults.
    prefs = Preferences()
    for key in Preferences.model_fields:
        if key in raw:
            try:
                prefs = Preferences.model_validate({**prefs.model_dump(), key: raw[key]})
            except ValidationError:
                pass
    return prefs


def update_preferences(changes: dict, path: Optional[Path] = None) -> Preferences:
    """Merge ``changes`` into the stored preferences and persist the result.

    Raises ``pydantic.ValidationError`` when the merged result is invalid.
    """
    dst = path or preferences_path()
    with _LOCK:
        current = _load(dst).model_dump()
        prefs = Preferences.model_validate({**current, **changes})
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(prefs.model_dump(), indent=2), encoding="utf-8")
        replace_file(tmp, dst)
        return prefs


__all__ = [
    "Preferences",
    "PreferencesPatch",
    "load_preferences",
    "update_preferences",
    "preferences_path",
]
