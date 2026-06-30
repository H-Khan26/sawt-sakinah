"""The ``Project`` container: an audio source plus all derived data and edit state.

A ``Project`` is what the frontend loads and works against. It bundles the
``AudioSource`` with detection output (silences, markers, prayer structure), the current
``EditDecisionList``, per-stage status, and any rendered export artifacts. Persisted as
``project.json`` by the service layer. Because every field is itself a pydantic model,
``Project.model_validate(json)`` rebuilds the whole tree. See
docs/audio/05-data-model-and-api.md.

Times are always in seconds (float).
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

from .edl import EditDecisionList
from .markers import Marker
from .segments import SilenceSegment
from .sources import AudioSource
from .structure import PrayerPosition


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
        path: On-disk location of the rendered file.
        duration_sec: Duration of the rendered audio, via ffprobe.
        bitrate: Encode bitrate if applicable (e.g. "192K"); ``None`` for VBR/lossless.
        edl_ref: ``EditDecisionList`` reference the artifact was rendered from.
        created_at: When the artifact was rendered.
    """

    model_config = ConfigDict(frozen=True)

    id: str
    format: str
    path: Path
    duration_sec: float
    bitrate: Optional[str] = None
    edl_ref: Optional[str] = None
    created_at: datetime = Field(default_factory=_now)


class Project(BaseModel):
    """Top-level container the frontend loads: audio + derived data + edit state."""

    model_config = ConfigDict(frozen=True)

    id: str
    audio_source: AudioSource
    silences: list[SilenceSegment] = Field(default_factory=list)
    markers: list[Marker] = Field(default_factory=list)
    structure: list[PrayerPosition] = Field(default_factory=list)
    edl: EditDecisionList
    status: ProjectStatus = Field(default_factory=ProjectStatus)
    exports: list[ExportArtifact] = Field(default_factory=list)

    def to_dict(self) -> dict:
        return self.model_dump(mode="json")

    @classmethod
    def from_dict(cls, data: dict) -> "Project":
        return cls.model_validate(data)
