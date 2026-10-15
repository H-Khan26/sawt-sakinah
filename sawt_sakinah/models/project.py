"""The ``Project`` container: an audio source plus all derived data and edit state.

A ``Project`` is what the frontend loads and works against. It bundles the
``AudioSource`` with detection output (silences, the surah map), the current
``EditDecisionList``, per-stage status, and any rendered export artifacts. Persisted as
``project.json`` by the service layer. Because every field is itself a pydantic model,
``Project.model_validate(json)`` rebuilds the whole tree. The on-disk format version
(``schema_version``) belongs to the store and ``migrations.py``, not to this model. See
docs/audio/05-data-model-and-api.md.

Times are always in seconds (float).
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from .edl import EditDecisionList
from .segments import SilenceSegment
from .sources import AudioSource
from .surahs import SurahMap


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ProjectStatus(BaseModel):
    """Per-stage progress flags for a project."""

    model_config = ConfigDict(frozen=True)

    extracted: bool = False
    analyzed: bool = False
    edited: bool = False


class ExportArtifact(BaseModel):
    """A rendered output file produced by an ``/export`` (the only audio-producing step).

    Attributes:
        id: Stable identifier (used in the export-download URL).
        format: Container/codec of the artifact, e.g. "mp3" or "wav".
        path: On-disk location of the rendered file: inside the project, or the user's
            copy when ``external``.
        duration_sec: Duration of the rendered audio, via ffprobe.
        bitrate: Encode bitrate if applicable (e.g. "192K"); ``None`` for VBR/lossless.
        edl_ref: ``EditDecisionList`` reference the artifact was rendered from.
        created_at: When the artifact was rendered.
        name: User-supplied label; drives the saved or downloaded file name.
        external: The file was saved to a user folder and belongs to the user: it may be
            moved or deleted outside the app, and deleting the project leaves it in place.
    """

    model_config = ConfigDict(frozen=True)

    id: str
    format: str
    path: Path
    duration_sec: float
    bitrate: Optional[str] = None
    edl_ref: Optional[str] = None
    created_at: datetime = Field(default_factory=_now)
    name: Optional[str] = None
    external: bool = False


class Project(BaseModel):
    """Top-level container the frontend loads: audio + derived data + edit state."""

    model_config = ConfigDict(frozen=True)

    id: str
    audio_source: AudioSource
    name: str = ""  # user-facing library label; seeded from audio_source.title on create
    silences: list[SilenceSegment] = Field(default_factory=list)
    surahs: Optional[SurahMap] = None  # None until surah matching has run
    edl: EditDecisionList
    status: ProjectStatus = Field(default_factory=ProjectStatus)
    exports: list[ExportArtifact] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)  # sort key for the library

    def to_dict(self) -> dict:
        return self.model_dump(mode="json")

    @classmethod
    def from_dict(cls, data: dict) -> "Project":
        return cls.model_validate(data)


class ProjectSummary(BaseModel):
    """Lightweight projection of a ``Project`` for the library list.

    Built by reading ``project.json`` once and projecting out only these fields -- it never
    runs the full ``load`` + ``_heal`` (which stats every audio/export file) so listing a
    whole library stays cheap. Path-free, so it doubles as its own wire view.
    """

    model_config = ConfigDict(frozen=True)

    id: str
    name: str
    source_kind: str = "youtube"        # provenance; "upload" for imported files
    source_url: Optional[str] = None    # None for uploads (and pre-source_kind sidecars)
    duration_sec: float
    created_at: datetime
    updated_at: datetime
    status: ProjectStatus = Field(default_factory=ProjectStatus)
    export_count: int = 0
    # Why the project can't be opened (newer version, damaged file); None when it can.
    unreadable: Optional[str] = None
