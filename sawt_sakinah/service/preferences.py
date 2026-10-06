"""Per-user app preferences, stored as JSON in the user config directory.

The desktop window's origin changes with its port, so preferences the UI used to keep in
``localStorage`` live here instead, next to the app-level choices (update check, Whisper
model). Reads tolerate a missing or corrupt file, and fall back to the default for any
single value that is no longer valid; writes are atomic.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, ConfigDict, ValidationError, field_validator, model_validator

from .. import runtime
from ..config import CONFIG
from .schemas import SILENCE_DETECTORS, WHISPER_MODELS

_LOCK = threading.Lock()
_NULLABLE = frozenset({"dismissed_update"})
_MAX_VERSION_LEN = 64


def _check_whisper_model(value: str) -> str:
    if value not in WHISPER_MODELS:
        raise ValueError(f"whisper_model must be one of: {', '.join(sorted(WHISPER_MODELS))}")
    return value


def _check_silence_detector(value: str) -> str:
    if value not in SILENCE_DETECTORS:
        allowed = ", ".join(sorted(SILENCE_DETECTORS))
        raise ValueError(f"silence_detector must be one of: {allowed}")
    return value


def _check_version(value: Optional[str]) -> Optional[str]:
    if value is not None and len(value) > _MAX_VERSION_LEN:
        raise ValueError("dismissed_update is too long")
    return value


class Preferences(BaseModel):
    """Everything the user can change from the UI that isn't project data."""

    update_check: bool = True
    dismissed_update: Optional[str] = None
    whisper_model: str = CONFIG.phrases.model_size
    show_deleted: bool = False
    silence_detector: str = CONFIG.silence.detector

    @field_validator("whisper_model")
    @classmethod
    def _check_model(cls, v: str) -> str:
        return _check_whisper_model(v)

    @field_validator("silence_detector")
    @classmethod
    def _check_detector(cls, v: str) -> str:
        return _check_silence_detector(v)

    @field_validator("dismissed_update")
    @classmethod
    def _check_dismissed(cls, v: Optional[str]) -> Optional[str]:
        return _check_version(v)


class PreferencesPatch(BaseModel):
    """Body of ``PATCH /app/preferences``: any subset of :class:`Preferences`.

    Unknown keys are rejected, and only ``dismissed_update`` may be set to ``null``.
    """

    model_config = ConfigDict(extra="forbid")

    update_check: Optional[bool] = None
    dismissed_update: Optional[str] = None
    whisper_model: Optional[str] = None
    show_deleted: Optional[bool] = None
    silence_detector: Optional[str] = None

    @field_validator("whisper_model")
    @classmethod
    def _check_model(cls, v: Optional[str]) -> Optional[str]:
        return v if v is None else _check_whisper_model(v)

    @field_validator("silence_detector")
    @classmethod
    def _check_detector(cls, v: Optional[str]) -> Optional[str]:
        return v if v is None else _check_silence_detector(v)

    @field_validator("dismissed_update")
    @classmethod
    def _check_dismissed(cls, v: Optional[str]) -> Optional[str]:
        return _check_version(v)

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
    src = path or preferences_path()
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
        current = load_preferences(dst).model_dump()
        prefs = Preferences.model_validate({**current, **changes})
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(prefs.model_dump(), indent=2), encoding="utf-8")
        os.replace(tmp, dst)
        return prefs


__all__ = [
    "Preferences",
    "PreferencesPatch",
    "load_preferences",
    "update_preferences",
    "preferences_path",
]
