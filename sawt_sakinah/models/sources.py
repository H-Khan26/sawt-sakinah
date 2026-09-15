"""The ``AudioSource`` contract: a local audio artifact plus its metadata.

Returned by the extraction layer and consumed by detection/editing/the API. Times are
seconds (float). See docs/audio/01-extraction.md and 05-data-model-and-api.md.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict

# Where an AudioSource's bytes came from. ``youtube`` is downloaded via yt-dlp;
# ``upload`` is a user-provided file (see extraction/importer.py). New kinds
# (e.g. a direct URL fetch) slot in here without touching downstream layers.
SourceKind = Literal["youtube", "upload"]


class AudioSource(BaseModel):
    """An acquired audio file and everything downstream layers need to know about it.

    Source-agnostic: the extraction layer produces one of these from a YouTube URL or a
    user upload, and detection/editing/the API never branch on where it came from.
    ``local_path`` is the user-facing artifact (always the transcoded mp3). ``working_copy``
    is an optional normalized PCM copy (16 kHz mono) that detection prefers for stable
    thresholds; it is populated by the normalization step and is ``None`` until then.
    """

    model_config = ConfigDict(frozen=True)

    local_path: Path         # user-facing artifact (the mp3)
    title: str               # yt-dlp video title, or the uploaded file's stem
    duration_sec: float      # authoritative, via ffprobe
    sample_rate: int         # of local_path, via ffprobe
    channels: int            # of local_path, via ffprobe
    codec: str               # e.g. "mp3", via ffprobe
    content_hash: str        # sha256 of the audio bytes, for caching/dedup
    id: str                  # deterministic short id (source key + format + quality)
    created_at: datetime     # when the audio was acquired (UTC)
    source_kind: SourceKind = "youtube"  # provenance; defaults keep old sidecars loading
    source_url: Optional[str] = None     # normalized canonical URL; None for uploads
    original_filename: Optional[str] = None  # uploaded file's name; None for YouTube
    working_copy: Optional[Path] = None  # 16 kHz mono WAV for detection

    def to_dict(self) -> dict:
        """JSON-safe dict (paths as strings, datetimes as ISO) for cache sidecars."""
        return self.model_dump(mode="json")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AudioSource":
        """Reconstruct an AudioSource from :meth:`to_dict` output (e.g. a cache sidecar)."""
        return cls.model_validate(data)
