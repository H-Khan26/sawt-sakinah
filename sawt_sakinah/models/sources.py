"""The ``AudioSource`` contract: a local audio artifact plus its metadata.

Returned by the extraction layer and consumed by detection/editing/the API. Times are
seconds (float). See docs/audio/01-extraction.md and 05-data-model-and-api.md.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict

# Where an AudioSource's bytes came from: a platform id from extraction/platforms.py
# (downloaded via yt-dlp), or ``upload`` for a user-provided file (see
# extraction/importer.py). A new platform adds its id here; downstream layers don't branch
# on it.
SourceKind = Literal["youtube", "instagram", "x", "facebook", "upload"]

#: A link import whose loudest sample is at or below this level (dBFS) is effectively
#: silent, e.g. a reel whose music was removed for copyright.
SILENT_PEAK_DBFS = -70.0


class AudioSource(BaseModel):
    """An acquired audio file and everything downstream layers need to know about it.

    Source-agnostic: the extraction layer produces one of these from a link or a user
    upload, and detection/editing/the API never branch on where it came from.
    ``local_path`` is the user-facing artifact (always the transcoded mp3). ``working_copy``
    is an optional normalized PCM copy (16 kHz mono) that detection prefers for stable
    thresholds; it is populated by the normalization step and is ``None`` until then.
    ``speech_map`` is the optional Silero speech-probability sidecar derived from the
    working copy; every speech-aware detector re-thresholds it instead of re-running
    the network. ``transcript`` is the optional word-level transcript sidecar (JSON) that
    surah matching writes, so matching can run again without transcribing. ``peak_dbfs``
    is the loudest sample of a link import (see :attr:`is_silent`); ``None`` for uploads
    and older sources.
    """

    model_config = ConfigDict(frozen=True)

    local_path: Path         # user-facing artifact (the mp3)
    title: str               # yt-dlp title, or the uploaded file's stem
    duration_sec: float      # authoritative, via ffprobe
    sample_rate: int         # of local_path, via ffprobe
    channels: int            # of local_path, via ffprobe
    codec: str               # e.g. "mp3", via ffprobe
    content_hash: str        # sha256 of the audio bytes, for caching/dedup
    id: str                  # deterministic short id (source key + format + quality)
    created_at: datetime     # when the audio was acquired (UTC)
    source_kind: SourceKind = "youtube"  # provenance; defaults keep old sidecars loading
    source_url: Optional[str] = None     # normalized canonical URL; None for uploads
    original_filename: Optional[str] = None  # uploaded file's name; None for links
    working_copy: Optional[Path] = None  # 16 kHz mono WAV for detection
    speech_map: Optional[Path] = None    # Silero speech-probability sidecar (.npz); None until computed or when the vad extra is missing
    transcript: Optional[Path] = None    # Whisper word transcript sidecar (.json); None until surah matching transcribes
    peak_dbfs: Optional[float] = None    # volumedetect max_volume of a link import; None when not measured

    @property
    def is_silent(self) -> bool:
        """Whether the measured peak says the audio is silent (a warning, not a failure)."""
        return self.peak_dbfs is not None and self.peak_dbfs <= SILENT_PEAK_DBFS

    def to_dict(self) -> dict:
        """JSON-safe dict (paths as strings, datetimes as ISO) for cache sidecars."""
        return self.model_dump(mode="json")

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "AudioSource":
        """Reconstruct an AudioSource from :meth:`to_dict` output (e.g. a cache sidecar)."""
        return cls.model_validate(data)
