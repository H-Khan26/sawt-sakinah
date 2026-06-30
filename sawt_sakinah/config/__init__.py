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

Override the whole file for a deployment by pointing ``SAWT_CONFIG_FILE`` at an
alternate copy. Service-only operational settings additionally accept ``SAWT_*``
environment overrides layered on top of :data:`CONFIG` (see service/settings.py).
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel, ConfigDict

_DEFAULTS_PATH = Path(__file__).with_name("defaults.yaml")
_ENV_PATH_VAR = "SAWT_CONFIG_FILE"


class _Section(BaseModel):
    """Base for every config section: strict, immutable, no implicit defaults."""

    model_config = ConfigDict(extra="forbid", frozen=True)


class FfmpegConfig(_Section):
    bin: str


class AudioConfig(_Section):
    working_sample_rate: int


class ExtractionConfig(_Section):
    audio_format: str
    audio_quality: str
    quiet: bool
    create_working_copy: bool
    normalize_loudness: bool
    use_cache: bool


class SilenceConfig(_Section):
    threshold_db: float
    min_silence_duration: float
    keep_silence: float
    merge_gap: Optional[float]
    measure_loudness: bool
    detector: str
    speech_threshold: float
    min_speech_duration: float


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
    keyword_gate: float
    fuzzy_floor: float
    fuzzy_weight: float


class EditingConfig(_Section):
    out_format: str
    boundary_fade: float
    mp3_vbr_quality: str
    embed_markers: bool
    embed_metadata: bool


class ServiceConfig(_Section):
    max_workers: int
    phrase_workers: int
    waveform_buckets: int
    stream_chunk_size: int


class Config(_Section):
    """Validated, immutable view of ``defaults.yaml`` (the whole knob surface)."""

    ffmpeg: FfmpegConfig
    audio: AudioConfig
    extraction: ExtractionConfig
    silence: SilenceConfig
    phrases: PhraseConfig
    editing: EditingConfig
    service: ServiceConfig


def config_path() -> Path:
    """Path the config is loaded from (``SAWT_CONFIG_FILE`` override, else the bundled file)."""
    override = os.environ.get(_ENV_PATH_VAR)
    return Path(override) if override else _DEFAULTS_PATH


def load_config(path: str | os.PathLike | None = None) -> Config:
    """Read, validate and return the config from ``path`` (or the resolved default path)."""
    src = Path(path) if path is not None else config_path()
    with src.open("r", encoding="utf-8") as fh:
        data = yaml.safe_load(fh) or {}
    return Config.model_validate(data)


@lru_cache(maxsize=1)
def get_config() -> Config:
    """Return the process-wide config singleton (loaded and validated once)."""
    return load_config()


# Evaluated at import: the single object every module binds its defaults from.
CONFIG: Config = get_config()

__all__ = ["CONFIG", "Config", "get_config", "load_config", "config_path"]
