"""Transcode an arbitrary local media file to the canonical user-facing audio artifact.

The upload counterpart of yt-dlp's ``FFmpegExtractAudio`` post-processor: given any
container ffmpeg can decode (m4a, mov, mp4, wav, flac, opus, ...), drop the video stream
and encode a single audio file in the target format. Output codec is inferred from the
destination extension, so ``foo.mp3`` yields libmp3lame -- matching the extractor's
default artifact. Side-effecting (subprocess + filesystem); performs no analysis.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from ..config import CONFIG


def _is_bitrate(quality: str) -> bool:
    """Whether ``quality`` is a bitrate (e.g. ``"192K"``) rather than a VBR quality level.

    yt-dlp's ``preferredquality`` accepts both; we mirror that: a trailing ``k``/``K``
    means a constant bitrate (``-b:a``), otherwise it is a VBR quality index (``-q:a``).
    """
    return quality.strip().lower().endswith("k")


def transcode_audio(
    src_path: str | Path,
    dst_path: str | Path,
    *,
    audio_quality: str = CONFIG.extraction.audio_quality,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
    overwrite: bool = True,
) -> Path:
    """Transcode ``src_path`` to the audio file ``dst_path`` and return its path.

    The output format/codec is taken from ``dst_path``'s extension. Video streams are
    dropped (``-vn``); only the first audio stream is encoded.

    Args:
        src_path: Any media file ffmpeg can decode.
        dst_path: Destination audio file; its extension selects the container/codec.
        audio_quality: ``"0"``-style VBR quality, or a bitrate like ``"192K"`` -- matched
            to the extractor's ``audio_quality`` so uploads and downloads sound alike.
        ffmpeg_bin: Name/path of the ffmpeg executable.
        overwrite: Overwrite ``dst_path`` if it already exists.

    Returns:
        Path to the produced audio file.

    Raises:
        FileNotFoundError: If ffmpeg or the input file is missing.
        RuntimeError: If FFmpeg exits with an error (e.g. an undecodable file).
    """
    src = Path(src_path)
    if not src.exists():
        raise FileNotFoundError(f"Input media not found: {src}")
    if shutil.which(ffmpeg_bin) is None:
        raise FileNotFoundError(
            f"'{ffmpeg_bin}' not found on PATH. Install FFmpeg (standalone binary)."
        )

    dst = Path(dst_path)
    dst.parent.mkdir(parents=True, exist_ok=True)

    cmd = [ffmpeg_bin, "-y" if overwrite else "-n", "-i", str(src), "-vn"]
    cmd += ["-b:a", audio_quality] if _is_bitrate(audio_quality) else ["-q:a", audio_quality]
    cmd += [str(dst)]

    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"FFmpeg transcode failed (exit {proc.returncode}):\n{proc.stderr.strip()}"
        )
    return dst
