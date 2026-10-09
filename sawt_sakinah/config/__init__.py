"""Single source of truth for every tuning knob in the package.

All default thresholds, durations, model choices and quality settings live in
``defaults.yaml`` next to this module. Code never carries its own literal defaults;
it reads them from the module-level :data:`CONFIG` object, e.g.::

    from ..config import CONFIG

    def detect_silence(..., threshold_db: float = CONFIG.silence.threshold_db, ...):

The schema below is strict on purpose:

* every field is REQUIRED (no defaults in code), so a missing YAML key fails loudly
  instead of silently falling back to a hidden default, and
* ``extra="forbid"`` rejects unknown/typo'd keys.

Together these guarantee the YAML and the code can never drift apart.

A per-user ``config.yaml`` (:func:`sawt_sakinah.runtime.user_config_file`) may override
any subset of keys; it is deep-merged onto the defaults and the result is validated with
the same strict schema, so a typo'd key there fails loudly too.

In a source checkout ``SAWT_CONFIG_FILE`` replaces the defaults file wholesale (the user
file still layers on top). The desktop bundle ignores it. Service-only operational
settings additionally accept ``SAWT_*`` environment overrides layered on top of
:data:`CONFIG` (see service/settings.py).
"""

from __future__ import annotations

import os
import re
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .. import runtime

# Package data next to this module; PyInstaller collects it under the same relative path.
_DEFAULTS_PATH = Path(__file__).with_name("defaults.yaml")
_ENV_PATH_VAR = "SAWT_CONFIG_FILE"


class ConfigError(ValueError):
    """A config file is unreadable or fails validation."""


class _Section(BaseModel):
    """Base for every config section: strict, immutable, no implicit defaults."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class FfmpegConfig(_Section):
    bin: str
    ffprobe_bin: str
    timeout_sec: float


class AudioConfig(_Section):
    working_sample_rate: int


class ExtractionConfig(_Section):
    audio_format: str
    audio_quality: str
    quiet: bool
    create_working_copy: bool
    create_speech_map: bool
    normalize_loudness: bool
    use_cache: bool
    max_upload_mb: int
    max_download_mb: int
    max_duration_sec: float
    allowed_upload_extensions: tuple[str, ...]


class SegmentationConfig(_Section):
    speech_threshold: float
    min_speech_duration: float
    bridge_gap: float
    speech_pad: float


class SilenceConfig(_Section):
    threshold_db: float
    min_silence_duration: float
    keep_silence: float
    merge_gap: Optional[float]
    measure_loudness: bool
    detector: str


class PhraseConfig(_Section):
    detector: str
    model_size: str
    device: str
    compute_type: str
    language: str
    min_confidence: float
    min_gap_between_markers: float
    max_word_gap: float
    vad_filter: bool
    snap_window: float
    clip_merge_gap: float
    clip_pad: float
    keyword_gate: float
    fuzzy_floor: float
    fuzzy_weight: float


_MODEL_ID = re.compile(r"[a-z0-9][a-z0-9.-]{0,63}")


class WhisperModelConfig(_Section):
    """One downloadable Whisper model, pinned to a Hugging Face commit."""

    label: str
    description: str
    repo: str
    revision: str = Field(pattern=r"^[0-9a-f]{40}$")
    size_mb: int


class EditingConfig(_Section):
    out_format: str
    boundary_fade: float
    mp3_vbr_quality: str
    embed_markers: bool
    embed_metadata: bool


class ServiceConfig(_Section):
    max_workers: int
    phrase_workers: int
    max_pending_jobs: int
    waveform_buckets: int
    stream_chunk_size: int


class AppConfig(_Section):
    release_repo: str
    update_check_interval_hours: float
    update_check_timeout_sec: float


class Config(_Section):
    """Validated, immutable view of ``defaults.yaml`` (the whole knob surface)."""

    ffmpeg: FfmpegConfig
    audio: AudioConfig
    extraction: ExtractionConfig
    segmentation: SegmentationConfig
    silence: SilenceConfig
    phrases: PhraseConfig
    whisper_models: dict[str, WhisperModelConfig]
    editing: EditingConfig
    service: ServiceConfig
    app: AppConfig

    @model_validator(mode="after")
    def _check_whisper_models(self) -> "Config":
        # Model ids name directories under the models folder.
        bad = [k for k in self.whisper_models if not _MODEL_ID.fullmatch(k)]
        if bad:
            raise ValueError(f"whisper_models ids must match {_MODEL_ID.pattern}: {bad}")
        if self.phrases.model_size not in self.whisper_models:
            raise ValueError(
                f"phrases.model_size {self.phrases.model_size!r} is not in whisper_models"
            )
        return self


def config_path() -> Path:
    """Base config file: ``SAWT_CONFIG_FILE`` in a source checkout, else the packaged defaults."""
    override = None if runtime.FROZEN else os.environ.get(_ENV_PATH_VAR)
    return Path(override) if override else _DEFAULTS_PATH


def _read_yaml(path: Path) -> dict:
    try:
        # Bytes let PyYAML detect the encoding (UTF-8 with or without a BOM, UTF-16); any
        # other encoding, such as an ANSI code page, fails to decode.
        with path.open("rb") as fh:
            data = yaml.safe_load(fh)
    except (OSError, ValueError, yaml.YAMLError) as exc:
        raise ConfigError(f"Could not read the settings file {path}: {exc}") from exc
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ConfigError(f"The settings file {path} must contain a mapping of sections.")
    return data


def _deep_merge(base: dict, override: dict) -> dict:
    """``base`` with ``override`` applied: nested mappings merge, everything else replaces."""
    merged: dict[str, Any] = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_config(
    path: str | os.PathLike | None = None,
    user_file: str | os.PathLike | None = None,
) -> Config:
    """Read, validate and return the config.

    ``path`` given: that file alone. Otherwise the base file from :func:`config_path` with
    ``user_file`` (default: the per-user ``config.yaml``, when it exists) merged on top.
    """
    if path is not None:
        return Config.model_validate(_read_yaml(Path(path)))
    data = _read_yaml(config_path())
    overrides = Path(user_file) if user_file is not None else runtime.user_config_file()
    if not overrides.is_file():
        return Config.model_validate(data)
    try:
        return Config.model_validate(_deep_merge(data, _read_yaml(overrides)))
    except ValidationError as exc:
        raise ConfigError(f"The settings file {overrides} is invalid:\n{exc}") from exc


#: Why the per-user ``config.yaml`` was ignored, when it was; the app reports it at startup.
USER_CONFIG_ERROR: Optional[str] = None


@lru_cache(maxsize=1)
def get_config() -> Config:
    """Return the process-wide config singleton (loaded and validated once).

    An invalid per-user ``config.yaml`` falls back to the defaults and is recorded in
    :data:`USER_CONFIG_ERROR`, so a typo there can't stop the app from starting.
    """
    global USER_CONFIG_ERROR
    try:
        return load_config()
    except ConfigError as exc:
        if not runtime.user_config_file().is_file():
            raise
        USER_CONFIG_ERROR = str(exc)
        return load_config(config_path())


# Evaluated at import: the single object every module binds its defaults from.
CONFIG: Config = get_config()

__all__ = [
    "CONFIG",
    "Config",
    "ConfigError",
    "USER_CONFIG_ERROR",
    "get_config",
    "load_config",
    "config_path",
]
