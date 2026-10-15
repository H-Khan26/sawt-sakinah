"""Request DTOs and wire-facing response views.

Domain pydantic models (``Project``, ``SilenceSegment``, ``Marker``, ``EditDecisionList``,
...) are reused directly as response bodies wherever they are already path-free. This
module adds two things on top:

* **Request DTOs** -- the inputs the frontend posts (``CreateProjectRequest``,
  ``SilenceParams``, ``PhraseRequest``, ``EdlUpdate``, ``ExportRequest``). The worker maps
  these onto the many internal detection/export kwargs.
* **Wire views** -- ``ProjectView`` / ``AudioSourceView`` / ``ExportArtifactView`` strip
  server filesystem paths (``local_path``, ``working_copy``, ``speech_map``, artifact
  ``path``) and expose endpoint URLs (or a presence flag) instead, so Windows/server
  paths never leak to the client. The one path shown is an export the user saved to
  their own folder (``saved_path``).
"""

from __future__ import annotations

import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Iterable, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from ..config import CONFIG
from ..models import (
    EditDecisionList,
    EditOperation,
    Marker,
    PrayerPosition,
    Project,
    ProjectStatus,
    ProjectSummary,
    SilenceSegment,
)

# --- allowed values ----------------------------------------------------------
# Request strings reach file names, ffmpeg arguments and model loading, so each is checked
# against a closed set. The configured default is always allowed, so an operator's
# defaults.yaml choice keeps working even when it is outside the built-in list.

EXPORT_FORMATS = frozenset({"mp3", "m4a", "wav", "flac"}) | {CONFIG.editing.out_format}
EXTRACT_FORMATS = frozenset({"mp3", "m4a", "wav", "flac", "opus"}) | {
    CONFIG.extraction.audio_format
}
SILENCE_DETECTORS = frozenset({"vad", "ffmpeg"})
# Only the models in the downloadable catalog (the config guarantees the default is one).
WHISPER_MODELS = frozenset(CONFIG.whisper_models)
# The desktop bundle ships CPU-only CTranslate2, so GPU devices and GPU compute types are refused.
WHISPER_DEVICES = frozenset({"cpu"})
WHISPER_COMPUTE_TYPES = frozenset(
    {"default", "auto", "int8", "int8_float32", "int16", "float32"}
) | {CONFIG.phrases.compute_type}
# ffmpeg bitrate ("192k") and VBR quality ("0".."9") forms.
_BITRATE = re.compile(r"[0-9]{2,3}[kK]")
_VBR_QUALITY = re.compile(r"[0-9]")
_LANGUAGE = re.compile(r"[a-z]{2,3}")
# Browsers yt-dlp can read YouTube cookies from, in display order; Safari only on macOS.
_COOKIE_BROWSER_ORDER = (
    "chrome", "edge", "firefox", "brave", "chromium", "vivaldi", "opera", "safari",
)
COOKIE_BROWSERS = frozenset(
    b for b in _COOKIE_BROWSER_ORDER if b != "safari" or sys.platform == "darwin"
)
_MAX_PATH_LEN = 1024


def cookie_browsers() -> list[str]:
    """The browsers offered for YouTube cookies on this OS, in display order."""
    return [b for b in _COOKIE_BROWSER_ORDER if b in COOKIE_BROWSERS]


def check_cookie_browser(value: str) -> str:
    return _one_of(value, COOKIE_BROWSERS, "cookies_browser")


def check_cookies_file(value: str, *, must_exist: bool = True) -> str:
    """A cookies.txt path: absolute, local (no UNC share) and, with ``must_exist``, an
    existing file. Returned as given."""
    message = "cookies_file must be an absolute path to an existing file"
    if not value or len(value) > _MAX_PATH_LEN or "\x00" in value:
        raise ValueError(message)
    # A network path would make the app contact that host just to check it.
    if value.startswith(("\\\\", "//")):
        raise ValueError("cookies_file must be on this computer, not a network share")
    path = Path(value)
    if not path.is_absolute() or (must_exist and not path.is_file()):
        raise ValueError(message)
    return value


def check_export_dir(value: str, *, must_exist: bool = True) -> str:
    """An export folder: absolute, local (no UNC share) and, with ``must_exist``, an
    existing directory. Returned as given."""
    message = "export_dir must be an absolute path to an existing folder"
    if not value or len(value) > _MAX_PATH_LEN or "\x00" in value:
        raise ValueError(message)
    if value.startswith(("\\\\", "//")):
        raise ValueError("export_dir must be on this computer, not a network share")
    path = Path(value)
    if not path.is_absolute() or (must_exist and not path.is_dir()):
        raise ValueError(message)
    return value


def _one_of(value: str, allowed: Iterable[str], field: str) -> str:
    if value not in allowed:
        raise ValueError(f"{field} must be one of: {', '.join(sorted(allowed))}")
    return value


# --- request DTOs ------------------------------------------------------------


class CreateProjectRequest(BaseModel):
    url: str
    audio_format: str = CONFIG.extraction.audio_format
    audio_quality: str = CONFIG.extraction.audio_quality

    @field_validator("audio_format")
    @classmethod
    def _check_format(cls, v: str) -> str:
        return _one_of(v, EXTRACT_FORMATS, "audio_format")

    @field_validator("audio_quality")
    @classmethod
    def _check_quality(cls, v: str) -> str:
        if not (_VBR_QUALITY.fullmatch(v) or _BITRATE.fullmatch(v)):
            raise ValueError('audio_quality must be a VBR level "0"-"9" or a bitrate like "192k"')
        return v


class CreateProjectResponse(BaseModel):
    project_id: str
    job_id: str


class JobAccepted(BaseModel):
    job_id: str


class SilenceParams(BaseModel):
    """Inputs for ``POST /detect/silence`` (mapped to ``detect_silence`` kwargs)."""

    threshold_db: float = CONFIG.silence.threshold_db
    min_silence_duration: float = CONFIG.silence.min_silence_duration
    merge_gap: Optional[float] = CONFIG.silence.merge_gap
    measure_loudness: bool = CONFIG.silence.measure_loudness
    detector: str = CONFIG.silence.detector
    speech_threshold: float = CONFIG.segmentation.speech_threshold
    min_speech_duration: float = CONFIG.segmentation.min_speech_duration

    @field_validator("detector")
    @classmethod
    def _check_detector(cls, v: str) -> str:
        return _one_of(v, SILENCE_DETECTORS, "detector")


class PhraseParams(BaseModel):
    """Inputs for ``POST /detect/phrases`` (mapped to ``detect_phrases`` kwargs)."""

    phrases: Optional[list[str]] = None
    # None uses the model the user selected (preferences), resolved when the job is submitted.
    model_size: Optional[str] = None
    device: str = CONFIG.phrases.device
    compute_type: str = CONFIG.phrases.compute_type
    language: str = CONFIG.phrases.language
    min_confidence: float = CONFIG.phrases.min_confidence
    min_gap_between_markers: float = CONFIG.phrases.min_gap_between_markers
    max_word_gap: float = CONFIG.phrases.max_word_gap
    vad_filter: bool = CONFIG.phrases.vad_filter
    snap_window: float = CONFIG.phrases.snap_window
    clip_merge_gap: float = CONFIG.phrases.clip_merge_gap
    clip_pad: float = CONFIG.phrases.clip_pad

    @field_validator("model_size")
    @classmethod
    def _check_model(cls, v: Optional[str]) -> Optional[str]:
        # Never an arbitrary Hugging Face repo id or local path.
        return v if v is None else _one_of(v, WHISPER_MODELS, "model_size")

    @field_validator("device")
    @classmethod
    def _check_device(cls, v: str) -> str:
        return _one_of(v, WHISPER_DEVICES, "device")

    @field_validator("compute_type")
    @classmethod
    def _check_compute_type(cls, v: str) -> str:
        return _one_of(v, WHISPER_COMPUTE_TYPES, "compute_type")

    @field_validator("language")
    @classmethod
    def _check_language(cls, v: str) -> str:
        if not _LANGUAGE.fullmatch(v):
            raise ValueError("language must be a 2-3 letter language code")
        return v


class PhraseRequest(BaseModel):
    params: PhraseParams = Field(default_factory=PhraseParams)
    references: Optional[dict] = None


class EdlUpdate(BaseModel):
    operations: list[EditOperation] = Field(default_factory=list)


class MarkersUpdate(BaseModel):
    """Inputs for ``PUT /projects/{id}/markers`` -- replaces the whole marker list.

    Structure is re-derived server-side from these markers, so the client never sends
    ``PrayerPosition``s directly. User-placed markers should carry ``source="user"``.
    """

    markers: list[Marker] = Field(default_factory=list)


class ExportRequest(BaseModel):
    format: str = CONFIG.editing.out_format
    bitrate: Optional[str] = None
    embed_markers: bool = CONFIG.editing.embed_markers
    name: Optional[str] = None  # file name label; defaults to the project name
    # Optional source-time range: when set, render only ``[range_start, range_end]`` (with the
    # project's existing edits inside it still applied) instead of the whole saved EDL. Leaves
    # the saved EDL untouched -- purely a scoped export of a selection.
    range_start: Optional[float] = None
    range_end: Optional[float] = None

    @field_validator("format")
    @classmethod
    def _check_format(cls, v: str) -> str:
        # The format becomes the output file's extension and ffmpeg's muxer choice.
        return _one_of(v, EXPORT_FORMATS, "format")

    @field_validator("bitrate")
    @classmethod
    def _check_bitrate(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not _BITRATE.fullmatch(v):
            raise ValueError('bitrate must look like "192k"')
        return v

    @model_validator(mode="after")
    def _check_range(self) -> "ExportRequest":
        a, b = self.range_start, self.range_end
        if (a is None) != (b is None):
            raise ValueError("range_start and range_end must be provided together")
        if a is not None and b is not None and a >= b:
            raise ValueError("range_start must be less than range_end")
        return self


class SplitRequest(BaseModel):
    """Body of ``POST /projects/{id}/split`` -- carve a source-time range into a new project.

    The range is rendered (with the source project's edits inside it applied) and imported as
    a fresh, independent project with its own audio and empty EDL.
    """

    range_start: float
    range_end: float
    name: Optional[str] = None  # library label for the new project; defaults to a derived name

    @model_validator(mode="after")
    def _check_range(self) -> "SplitRequest":
        if self.range_start >= self.range_end:
            raise ValueError("range_start must be less than range_end")
        return self


class PatchProjectRequest(BaseModel):
    """Body of ``PATCH /projects/{id}`` -- rename / metadata edits."""

    name: str = Field(max_length=200)

    @field_validator("name")
    @classmethod
    def _non_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("name must not be empty")
        return v


# --- wire-facing views (paths stripped) --------------------------------------


class AudioSourceView(BaseModel):
    id: str
    source_kind: str                    # "youtube" | "upload"
    source_url: Optional[str] = None    # None for uploads
    original_filename: Optional[str] = None  # set for uploads
    title: str
    duration_sec: float
    sample_rate: int
    channels: int
    codec: str
    content_hash: str
    created_at: datetime
    audio_url: str
    has_speech_map: bool  # speech-aware controls (VAD silence, snapping) are available


class ExportArtifactView(BaseModel):
    id: str
    format: str
    duration_sec: float
    bitrate: Optional[str] = None
    edl_ref: Optional[str] = None
    created_at: datetime
    name: Optional[str] = None
    download_url: Optional[str] = None  # None once the file was saved to a user folder
    saved_path: Optional[str] = None  # where it was saved; it may have moved since


class ProjectView(BaseModel):
    id: str
    audio_source: AudioSourceView
    name: str
    silences: list[SilenceSegment]
    markers: list[Marker]
    structure: list[PrayerPosition]
    edl: EditDecisionList
    status: ProjectStatus
    exports: list[ExportArtifactView]
    created_at: datetime
    updated_at: datetime


class WhisperModelView(BaseModel):
    """One entry of ``GET /models``."""

    id: str
    label: str
    description: str
    size_mb: int
    installed: bool
    selected: bool  # the user's chosen model (preferences.whisper_model)
    download_job_id: Optional[str] = None  # pending/running download job, if any


class ProjectListResponse(BaseModel):
    """Body of ``GET /projects``. ``ProjectSummary`` is already path-free, so it doubles
    as the wire view -- no path-stripping projection needed."""

    projects: list[ProjectSummary]


def to_project_view(project: Project) -> ProjectView:
    """Project the domain ``Project`` onto its path-free wire representation."""
    s = project.audio_source
    audio = AudioSourceView(
        id=s.id,
        source_kind=s.source_kind,
        source_url=s.source_url,
        original_filename=s.original_filename,
        title=s.title,
        duration_sec=s.duration_sec,
        sample_rate=s.sample_rate,
        channels=s.channels,
        codec=s.codec,
        content_hash=s.content_hash,
        created_at=s.created_at,
        audio_url=f"/projects/{project.id}/audio",
        has_speech_map=s.speech_map is not None,
    )
    exports = [
        ExportArtifactView(
            id=a.id,
            format=a.format,
            duration_sec=a.duration_sec,
            bitrate=a.bitrate,
            edl_ref=a.edl_ref,
            created_at=a.created_at,
            name=a.name,
            download_url=None if a.external else f"/projects/{project.id}/exports/{a.id}",
            saved_path=str(a.path) if a.external else None,
        )
        for a in project.exports
    ]
    return ProjectView(
        id=project.id,
        audio_source=audio,
        name=project.name,
        silences=project.silences,
        markers=project.markers,
        structure=project.structure,
        edl=project.edl,
        status=project.status,
        exports=exports,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )
