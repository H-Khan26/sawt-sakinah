"""Request DTOs and wire-facing response views.

Domain pydantic models (``Project``, ``SilenceSegment``, ``SurahMap``,
``EditDecisionList``, ...) are reused directly as response bodies wherever they are already
path-free. This module adds two things on top:

* **Request DTOs** -- the inputs the frontend posts (``CreateProjectRequest``,
  ``SilenceParams``, ``SurahRequest``, ``EdlUpdate``, ``ExportRequest``, ``SplitRequest``).
  The worker maps these onto the many internal detection/export kwargs.
* **Wire views** -- ``ProjectView`` / ``AudioSourceView`` / ``ExportArtifactView`` strip
  server filesystem paths (``local_path``, ``working_copy``, ``speech_map``,
  ``transcript``, artifact ``path``) and expose endpoint URLs (or a presence flag)
  instead, so Windows/server paths never leak to the client. The one path shown is an export the user saved to
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
    Project,
    ProjectStatus,
    ProjectSummary,
    SilenceSegment,
    SurahMap,
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
# ffmpeg bitrate ("192k") and VBR quality ("0".."9") forms.
_BITRATE = re.compile(r"[0-9]{2,3}[kK]")
_VBR_QUALITY = re.compile(r"[0-9]")
# Browsers yt-dlp can read YouTube cookies from, in display order; Safari only on macOS.
_COOKIE_BROWSER_ORDER = (
    "chrome", "edge", "firefox", "brave", "chromium", "vivaldi", "opera", "safari",
)
COOKIE_BROWSERS = frozenset(
    b for b in _COOKIE_BROWSER_ORDER if b != "safari" or sys.platform == "darwin"
)
_MAX_PATH_LEN = 1024
# Ranges one split may join; each becomes a slice in the render's filter graph.
_MAX_SPLIT_RANGES = 500


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


class SurahRequest(BaseModel):
    """Inputs for ``POST /detect/surahs``. The model and thresholds come from the config."""

    # Match the saved transcript again when it came from the current model, instead of
    # transcribing the recording anew.
    reuse_transcript: bool = True


class EdlUpdate(BaseModel):
    operations: list[EditOperation] = Field(default_factory=list)


class ExportRequest(BaseModel):
    format: str = CONFIG.editing.out_format
    bitrate: Optional[str] = None
    embed_chapters: bool = CONFIG.editing.embed_chapters  # accepted surah passages as chapters
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
    """Body of ``POST /projects/{id}/split`` -- copy source-time ranges into a new project.

    The ranges are rendered back to back (with the source project's edits inside them
    applied) and imported as a fresh, independent project with its own audio and empty EDL.
    They are stored sorted, with overlapping or touching ranges merged.
    """

    ranges: list[tuple[float, float]] = Field(min_length=1, max_length=_MAX_SPLIT_RANGES)
    name: Optional[str] = None  # library label for the new project; defaults to a derived name

    @field_validator("ranges")
    @classmethod
    def _check_ranges(cls, v: list[tuple[float, float]]) -> list[tuple[float, float]]:
        merged: list[tuple[float, float]] = []
        for a, b in sorted(v):
            if a < 0 or a >= b:
                raise ValueError("each range must have 0 <= start < end")
            if merged and a <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], b))
            else:
                merged.append((a, b))
        return merged


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
    source_kind: str                    # a platform id ("youtube", "instagram", ...) or "upload"
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
    has_transcript: bool  # surahs can be matched again without transcribing


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
    surahs: Optional[SurahMap] = None
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
        has_transcript=s.transcript is not None,
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
        surahs=project.surahs,
        edl=project.edl,
        status=project.status,
        exports=exports,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )
