"""Request DTOs and wire-facing response views.

Domain pydantic models (``Project``, ``SilenceSegment``, ``Marker``, ``EditDecisionList``,
...) are reused directly as response bodies wherever they are already path-free. This
module adds two things on top:

* **Request DTOs** -- the inputs the frontend posts (``CreateProjectRequest``,
  ``SilenceParams``, ``PhraseRequest``, ``EdlUpdate``, ``ExportRequest``). The worker maps
  these onto the many internal detection/export kwargs.
* **Wire views** -- ``ProjectView`` / ``AudioSourceView`` / ``ExportArtifactView`` strip
  server filesystem paths (``local_path``, ``working_copy``, artifact ``path``) and expose
  endpoint URLs instead, so Windows/server paths never leak to the client.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field

from ..models import (
    EditDecisionList,
    EditOperation,
    Marker,
    PrayerPosition,
    Project,
    ProjectStatus,
    SilenceSegment,
)

# --- request DTOs ------------------------------------------------------------


class CreateProjectRequest(BaseModel):
    url: str
    audio_format: str = "mp3"
    audio_quality: str = "0"


class CreateProjectResponse(BaseModel):
    project_id: str
    job_id: str


class JobAccepted(BaseModel):
    job_id: str


class SilenceParams(BaseModel):
    """Inputs for ``POST /detect/silence`` (mapped to ``detect_silence`` kwargs)."""

    threshold_db: float = -40.0
    min_silence_duration: float = 1.0
    merge_gap: Optional[float] = None
    measure_loudness: bool = True
    detector: str = "ffmpeg"
    speech_threshold: float = 0.5


class PhraseParams(BaseModel):
    """Inputs for ``POST /detect/phrases`` (mapped to ``detect_phrases`` kwargs)."""

    phrases: Optional[list[str]] = None
    model_size: str = "large-v3"
    device: str = "cpu"
    compute_type: str = "int8"
    language: str = "ar"
    min_confidence: float = 0.4
    min_gap_between_markers: float = 1.0
    max_word_gap: float = 1.0
    vad_filter: bool = True


class PhraseRequest(BaseModel):
    params: PhraseParams = Field(default_factory=PhraseParams)
    references: Optional[dict] = None


class EdlUpdate(BaseModel):
    operations: list[EditOperation] = Field(default_factory=list)


class ExportRequest(BaseModel):
    format: str = "mp3"
    bitrate: Optional[str] = None
    embed_markers: bool = True


# --- wire-facing views (paths stripped) --------------------------------------


class AudioSourceView(BaseModel):
    id: str
    source_url: str
    title: str
    duration_sec: float
    sample_rate: int
    channels: int
    codec: str
    content_hash: str
    created_at: datetime
    audio_url: str


class ExportArtifactView(BaseModel):
    id: str
    format: str
    duration_sec: float
    bitrate: Optional[str] = None
    edl_ref: Optional[str] = None
    created_at: datetime
    download_url: str


class ProjectView(BaseModel):
    id: str
    audio_source: AudioSourceView
    silences: list[SilenceSegment]
    markers: list[Marker]
    structure: list[PrayerPosition]
    edl: EditDecisionList
    status: ProjectStatus
    exports: list[ExportArtifactView]


def to_project_view(project: Project) -> ProjectView:
    """Project the domain ``Project`` onto its path-free wire representation."""
    s = project.audio_source
    audio = AudioSourceView(
        id=s.id,
        source_url=s.source_url,
        title=s.title,
        duration_sec=s.duration_sec,
        sample_rate=s.sample_rate,
        channels=s.channels,
        codec=s.codec,
        content_hash=s.content_hash,
        created_at=s.created_at,
        audio_url=f"/projects/{project.id}/audio",
    )
    exports = [
        ExportArtifactView(
            id=a.id,
            format=a.format,
            duration_sec=a.duration_sec,
            bitrate=a.bitrate,
            edl_ref=a.edl_ref,
            created_at=a.created_at,
            download_url=f"/projects/{project.id}/exports/{a.id}",
        )
        for a in project.exports
    ]
    return ProjectView(
        id=project.id,
        audio_source=audio,
        silences=project.silences,
        markers=project.markers,
        structure=project.structure,
        edl=project.edl,
        status=project.status,
        exports=exports,
    )
