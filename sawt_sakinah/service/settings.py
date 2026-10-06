"""Service configuration via environment variables (``SAWT_*``) or a ``.env`` file."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from ..config import CONFIG
from ..extraction.cache import default_cache_dir
from .projects import default_projects_dir


def default_static_dir() -> Path:
    """The built SPA directory in a source checkout: ``<repo>/frontend/dist``.

    Derived from this file's location (``<repo>/sawt_sakinah/service/settings.py``). It may
    not exist (the frontend isn't built yet); the app mounts it only when present, so dev —
    which serves the SPA from Vite — is unaffected. Override with ``SAWT_STATIC_DIR``.
    """
    return Path(__file__).resolve().parents[2] / "frontend" / "dist"


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
        static_dir: Built SPA directory to serve at ``/`` (same-origin). Mounted only when
            it exists, so the dev Vite server is unaffected.
        allowed_hosts: Hostnames accepted in the ``Host`` header and in the ``Origin`` of
            state-changing requests. Blocks DNS rebinding and cross-site writes. As an
            env var, a JSON list: ``SAWT_ALLOWED_HOSTS='["127.0.0.1","localhost"]'``.
        allowed_origins: Extra origins allowed to make state-changing requests, beyond the
            service's own (e.g. the Vite dev server). A JSON list as an env var.
        auth_token: Per-launch secret required on every request (``X-Sawt-Token`` header
            or the session cookie set by ``/_session``). ``None`` disables the check; the
            desktop shell always sets one.
    """

    model_config = SettingsConfigDict(env_prefix="SAWT_", env_file=".env", extra="ignore")

    projects_dir: Path = Field(default_factory=default_projects_dir)
    cache_dir: Path = Field(default_factory=default_cache_dir)
    # Base defaults come from the single config file; SAWT_* env vars override them.
    max_workers: int = CONFIG.service.max_workers
    phrase_workers: int = CONFIG.service.phrase_workers
    ffmpeg_bin: str = CONFIG.ffmpeg.bin
    static_dir: Optional[Path] = Field(default_factory=default_static_dir)
    allowed_hosts: list[str] = Field(default_factory=lambda: ["127.0.0.1", "localhost"])
    allowed_origins: list[str] = Field(default_factory=list)
    auth_token: Optional[str] = None
