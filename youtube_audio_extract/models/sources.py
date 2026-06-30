"""The ``AudioSource`` contract: a local audio artifact plus its metadata.

Returned by the extraction layer and consumed by detection/editing/the API. Times are
seconds (float). See docs/audio/01-extraction.md and 05-data-model-and-api.md.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, computed_field


class AudioSource(BaseModel):
    """A downloaded audio file and everything downstream layers need to know about it.

    ``local_path`` is the user-facing artifact (e.g. the mp3). ``working_copy`` is an
    optional normalized PCM copy (16 kHz mono) that detection prefers for stable
    thresholds; it is populated by the normalization step (Phase 3) and is ``None``
    until then.
    """

    model_config = ConfigDict(frozen=True)

    source_url: str          # normalized canonical URL
    local_path: Path         # user-facing artifact (the mp3)
    title: str               # from yt-dlp info
    duration_sec: float      # authoritative, via ffprobe
    sample_rate: int         # of local_path, via ffprobe
    channels: int            # of local_path, via ffprobe
    codec: str               # e.g. "mp3", via ffprobe
    content_hash: str        # sha256 of the audio bytes, for caching/dedup
    id: str                  # deterministic short id (url + format + quality)
    extracted_at: datetime
    working_copy: Optional[Path] = None  # 16 kHz mono WAV for detection (Phase 3)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def created_at(self) -> datetime:
        """Alias for ``extracted_at`` (doc 05 names the field ``created_at``)."""
        return self.extracted_at

    def to_dict(self) -> dict:
        """JSON-safe dict (paths as strings, datetimes as ISO) for cache sidecars."""
        return self.model_dump(mode="json")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AudioSource":
        """Reconstruct an AudioSource from :meth:`to_dict` output (e.g. a cache sidecar)."""
        return cls.model_validate(data)
