"""Ingest a user-uploaded media file as an :class:`AudioSource`.

The upload counterpart of :mod:`extractor`: instead of downloading from a link, it takes
a local file the user provided, validates that ffmpeg can decode it and that it carries an
audio stream, transcodes it to the canonical mp3 artifact, and hands off to the shared
:func:`finalize_source` tail. Detection/editing/the API stay oblivious to the difference --
they only ever see an :class:`AudioSource`.

Side-effecting (subprocess + filesystem). Performs no analysis or editing.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Callable, Optional

from ..config import CONFIG
from ..models.errors import NoAudioStreamError, UnsupportedMediaError
from ..models.sources import AudioSource
from . import cache as _cache
from .finalize import emit as _emit
from .finalize import finalize_source
from .hashing import content_hash
from .probe import probe
from .transcode import transcode_audio


def _source_id(content_hash_hex: str, audio_format: str, audio_quality: str) -> str:
    """Deterministic short id for an upload, keyed by content so identical files dedupe."""
    key = f"upload|{content_hash_hex}|{audio_format}|{audio_quality}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def _validate_decodable(src: Path, ffprobe_bin: str) -> None:
    """Ensure ffprobe can read ``src`` and it has an audio stream, else raise typed errors.

    ffprobe failing means the file is not decodable media (wrong type despite its
    extension, or corrupt) -> :class:`UnsupportedMediaError`. Decoding fine but finding no
    audio stream (e.g. a silent video) -> :class:`NoAudioStreamError`.
    """
    try:
        probe(src, ffprobe_bin=ffprobe_bin)
    except RuntimeError as err:
        if "no audio stream" in str(err).lower():
            raise NoAudioStreamError(
                f"'{src.name}' has no audio track to extract."
            ) from err
        raise UnsupportedMediaError(
            f"'{src.name}' could not be read as media: {err}"
        ) from err


def import_file(
    src_path: str | os.PathLike,
    output_dir: str | os.PathLike = ".",
    *,
    original_filename: str | None = None,
    audio_format: str = CONFIG.extraction.audio_format,
    audio_quality: str = CONFIG.extraction.audio_quality,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
    ffprobe_bin: str = CONFIG.ffmpeg.ffprobe_bin,
    create_working_copy: bool = CONFIG.extraction.create_working_copy,
    normalize_loudness: bool = CONFIG.extraction.normalize_loudness,
    use_cache: bool = CONFIG.extraction.use_cache,
    cache_dir: str | os.PathLike | None = None,
    progress_callback: Optional[Callable[[dict], None]] = None,
) -> AudioSource:
    """Transcode a user upload to the canonical audio artifact and return an ``AudioSource``.

    Args:
        src_path: Path to the uploaded file (e.g. a staged temp file).
        output_dir: Directory to write the transcoded artifact into (created if missing).
        original_filename: The name the user uploaded, used for the title and recorded on
            the source. Defaults to ``src_path``'s name.
        audio_format: Target artifact format/extension (default ``mp3``).
        audio_quality: FFmpeg audio quality (``"0"`` best VBR, or a bitrate like ``"192K"``).
        ffmpeg_bin: Name/path of the ffmpeg executable.
        ffprobe_bin: Name/path of the ffprobe executable.
        create_working_copy: Also emit the 16 kHz mono WAV detection feeds on.
        normalize_loudness: Apply EBU R128 loudnorm to the working copy.
        use_cache: Reuse/persist by content hash so re-uploading the same file is cheap.
        cache_dir: Cache root. Defaults to :func:`cache.default_cache_dir`.
        progress_callback: Normalized ``{stage, ...}`` sink; stages are ``"transcode"``,
            ``"probe"``, ``"normalize"``, ``"done"`` (or ``"cache"`` on a hit).

    Returns:
        An :class:`AudioSource` describing the transcoded artifact.

    Raises:
        FileNotFoundError: If ``src_path`` or ffmpeg/ffprobe is missing.
        UnsupportedMediaError: If the extension is not accepted or ffmpeg cannot decode it.
        NoAudioStreamError: If the file carries no audio stream.
    """
    src = Path(src_path)
    if not src.exists():
        raise FileNotFoundError(f"Uploaded file not found: {src}")

    name = original_filename or src.name
    ext = Path(name).suffix.lower() or src.suffix.lower()
    if ext not in CONFIG.extraction.allowed_upload_extensions:
        allowed = ", ".join(CONFIG.extraction.allowed_upload_extensions)
        raise UnsupportedMediaError(
            f"'{name}' is not a supported file type. Accepted: {allowed}."
        )

    _validate_decodable(src, ffprobe_bin)

    source_id = _source_id(content_hash(src), audio_format, audio_quality)
    resolved_cache_dir = (
        Path(cache_dir) if cache_dir is not None else _cache.default_cache_dir()
    )
    if use_cache:
        cached = _cache.load(resolved_cache_dir, source_id)
        if cached is not None:
            _emit(progress_callback, stage="cache", status="hit", percent=100.0)
            return cached

    # A server-generated, id-based filename: never trust the client's name for a path.
    result = Path(output_dir) / f"{source_id}.{audio_format}"
    _emit(progress_callback, stage="transcode", status="start")
    transcode_audio(src, result, audio_quality=audio_quality, ffmpeg_bin=ffmpeg_bin)

    return finalize_source(
        result,
        source_id=source_id,
        title=Path(name).stem,
        source_kind="upload",
        original_filename=name,
        create_working_copy=create_working_copy,
        normalize_loudness=normalize_loudness,
        use_cache=use_cache,
        cache_dir=resolved_cache_dir,
        ffmpeg_bin=ffmpeg_bin,
        ffprobe_bin=ffprobe_bin,
        progress_callback=progress_callback,
    )
