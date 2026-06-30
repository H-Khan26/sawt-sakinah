"""The ``AudioSource`` contract: a local audio artifact plus its metadata.

Returned by the extraction layer and consumed by detection/editing/the API. Times are
seconds (float). See docs/audio/01-extraction.md and 05-data-model-and-api.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional


@dataclass(frozen=True)
class AudioSource:
    """A downloaded audio file and everything downstream layers need to know about it.

    ``local_path`` is the user-facing artifact (e.g. the mp3). ``working_copy`` is an
    optional normalized PCM copy (16 kHz mono) that detection prefers for stable
    thresholds; it is populated by the normalization step (Phase 3) and is ``None``
    until then.
    """

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

    @property
    def created_at(self) -> datetime:
        """Alias for ``extracted_at`` (doc 05 names the field ``created_at``)."""
        return self.extracted_at

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "source_url": self.source_url,
            "local_path": str(self.local_path),
            "title": self.title,
            "duration_sec": self.duration_sec,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "codec": self.codec,
            "content_hash": self.content_hash,
            "extracted_at": self.extracted_at.isoformat(),
            "working_copy": str(self.working_copy) if self.working_copy is not None else None,
        }
