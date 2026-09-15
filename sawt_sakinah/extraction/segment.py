"""Persist the Silero speech-probability map as a sidecar next to the working copy.

The network pass itself lives in ``detection/segmentation.py``; this module only decides
where the result goes on disk and writes it. The write lives in the extraction
(side-effecting) layer so detection keeps its read-only contract, exactly as the working
copy is produced here rather than by the detectors that consume it.
"""

from __future__ import annotations

import os
from pathlib import Path

from ..config import CONFIG
from .normalize import WORKING_SUFFIX

SPEECH_MAP_SUFFIX = ".speech.npz"


def speech_map_path(working_copy: str | Path) -> Path:
    """Default sidecar path for ``working_copy``: ``x.work.wav`` -> ``x.speech.npz``.

    Strips the working-copy suffix when present so the sidecar shares the source's stem;
    any other input just swaps its extension.
    """
    src = Path(working_copy)
    name = src.name
    if name.endswith(WORKING_SUFFIX):
        stem = name[: -len(WORKING_SUFFIX)]
    else:
        stem = src.stem
    return src.with_name(f"{stem}{SPEECH_MAP_SUFFIX}")


def write_speech_map(
    working_copy: str | Path,
    output_path: str | Path | None = None,
    ffmpeg_bin: str = CONFIG.ffmpeg.bin,
) -> Path:
    """Compute the speech map for ``working_copy`` and write it to ``output_path``.

    The map is written to a temporary ``.npz`` beside the destination and moved into
    place with ``os.replace``, so a crash or a concurrent reader never observes a
    truncated sidecar: the destination is either the previous file or the complete new
    one.

    Args:
        working_copy: 16 kHz mono audio (any ffmpeg-readable file works; it is decoded
            in memory through the shared PCM decode).
        output_path: Destination ``.npz``. Defaults to :func:`speech_map_path`.
        ffmpeg_bin: Name/path of the ffmpeg executable.

    Returns:
        Path to the written sidecar.

    Raises:
        FileNotFoundError: If ``working_copy`` is missing.
        ValueError: If ``output_path`` does not end in ``.npz``.
        ImportError: If onnxruntime (the ``vad`` extra) is not installed.
        RuntimeError: If ffmpeg fails to decode the input.
    """
    from ..detection.segmentation import SpeechMap

    src = Path(working_copy)
    if not src.exists():
        raise FileNotFoundError(f"Working copy not found: {src}")
    dst = Path(output_path) if output_path is not None else speech_map_path(src)
    if dst.suffix != ".npz":
        raise ValueError(f"Speech map path must end in .npz: {dst}")
    # Keep the .npz suffix on the temp name so np.savez does not append its own.
    tmp = dst.with_name(f"{dst.stem}.tmp.npz")
    speech_map = SpeechMap.compute(src, ffmpeg_bin)
    try:
        speech_map.save(tmp)
        os.replace(tmp, dst)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise
    return dst
