"""Read authoritative audio metadata from a file using ffprobe (ships with FFmpeg).

Also exposes :func:`ffprobe_for` so callers in other layers can derive the correct
``ffprobe`` path from a custom ``ffmpeg`` binary without duplicating the logic.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path


def ffprobe_for(ffmpeg_bin: str) -> str:
    """Return the ``ffprobe`` path that corresponds to a given ``ffmpeg`` binary.

    For a bare ``"ffmpeg"`` (or empty string), returns ``"ffprobe"``. For a full path
    (e.g. ``"/usr/local/bin/ffmpeg"``), returns ``"/usr/local/bin/ffprobe"``.
    """
    if ffmpeg_bin in ("ffmpeg", ""):
        return "ffprobe"
    return str(Path(ffmpeg_bin).with_name("ffprobe"))


def probe(input_path: str | Path, ffprobe_bin: str = "ffprobe") -> dict:
    """Return stream-accurate metadata for ``input_path``.

    Reads the first audio stream and the container with ffprobe and returns a dict
    with keys ``duration_sec`` (float), ``sample_rate`` (int), ``channels`` (int),
    and ``codec`` (str). Read-only: never modifies the file.

    Args:
        input_path: Source audio file.
        ffprobe_bin: Name/path of the ffprobe executable.

    Raises:
        FileNotFoundError: If ffprobe or the input file is missing.
        RuntimeError: If ffprobe fails or returns no audio stream.
    """
    src = Path(input_path)
    if not src.exists():
        raise FileNotFoundError(f"Input audio not found: {src}")
    if shutil.which(ffprobe_bin) is None:
        raise FileNotFoundError(
            f"'{ffprobe_bin}' not found on PATH. Install FFmpeg (ffprobe ships with it)."
        )

    cmd = [
        ffprobe_bin,
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate,channels,codec_name:format=duration",
        "-of", "json",
        str(src),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"ffprobe failed (exit {proc.returncode}):\n{proc.stderr.strip()}"
        )

    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams") or []
    if not streams:
        raise RuntimeError(f"ffprobe found no audio stream in {src}")
    stream = streams[0]

    # Duration usually lives on the container; fall back to the stream if absent.
    duration_raw = (data.get("format") or {}).get("duration") or stream.get("duration")

    return {
        "duration_sec": float(duration_raw) if duration_raw is not None else 0.0,
        "sample_rate": int(stream["sample_rate"]) if stream.get("sample_rate") else 0,
        "channels": int(stream["channels"]) if stream.get("channels") else 0,
        "codec": stream.get("codec_name", ""),
    }
