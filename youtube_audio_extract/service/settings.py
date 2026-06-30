"""Service configuration via environment variables (``YAE_*``) or a ``.env`` file."""

from __future__ import annotations

from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from ..config import CONFIG
from ..extraction.cache import default_cache_dir
from .projects import default_projects_dir


class ServiceSettings(BaseSettings):
    """Runtime settings for the FastAPI service.

    Attributes:
        projects_dir: Root directory for per-project storage.
        cache_dir: Extraction cache root (shared with the library) so identical
            downloads are deduped across projects.
        max_workers: Threads for the general job pool (extraction / silence / export).
        phrase_workers: Threads for the dedicated phrase (Whisper) pool; keep at 1
            unless the device can run concurrent transcriptions.
        ffmpeg_bin: Name/path of the ffmpeg executable.
    """

    model_config = SettingsConfigDict(env_prefix="YAE_", env_file=".env", extra="ignore")

    projects_dir: Path = Field(default_factory=default_projects_dir)
    cache_dir: Path = Field(default_factory=default_cache_dir)
    # Base defaults come from the single config file; YAE_* env vars override them.
    max_workers: int = CONFIG.service.max_workers
    phrase_workers: int = CONFIG.service.phrase_workers
    ffmpeg_bin: str = CONFIG.ffmpeg.bin
