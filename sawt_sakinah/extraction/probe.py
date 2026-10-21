"""Read authoritative audio metadata from a file using ffprobe (ships with FFmpeg), and
measure its peak level with ffmpeg."""

from __future__ import annotations

import json
import re
from pathlib import Path

from ..config import CONFIG
from ..ffmpeg import run_ffmpeg
from ..proc import INPUT_PROTOCOLS, ffmpeg_input


def probe(input_path: str | Path, ffprobe_bin: str = CONFIG.ffmpeg.ffprobe_bin) -> dict:
    """Return stream-accurate metadata for ``input_path``.

    Reads the first audio stream and the container with ffprobe and returns a dict
    with keys ``duration_sec`` (float), ``sample_rate`` (int), ``channels`` (int),
    and ``codec`` (str). Read-only: never modifies the file.

    Args:
        input_path: Source audio file.
        ffprobe_bin: Name/path of the ffprobe executable.

    Raises:
        FileNotFoundError: If ffprobe or the input file is missing.
        RuntimeError: If ffprobe fails, times out or returns no audio stream.
    """
    src = Path(input_path)
    if not src.exists():
        raise FileNotFoundError(f"Input audio not found: {src}")

    cmd = [
        ffprobe_bin,
        "-v", "error",
        *INPUT_PROTOCOLS,
        "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate,channels,codec_name:format=duration",
        "-of", "json",
        "-i", str(src),
    ]
    proc = run_ffmpeg(cmd)
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


_MAX_VOL_RE = re.compile(r"max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB")

#: Floor for a peak reading; digital silence reads ``-inf`` dB, which JSON can't hold.
PEAK_FLOOR_DBFS = -120.0


def peak_dbfs(input_path: str | Path, ffmpeg_bin: str = CONFIG.ffmpeg.bin) -> float | None:
    """The loudest sample of ``input_path`` in dBFS (ffmpeg's ``volumedetect``).

    Returns at least :data:`PEAK_FLOOR_DBFS`, or ``None`` when ffmpeg is missing, fails,
    times out or reports no level: the reading only feeds a warning. Read-only.
    """
    cmd = [ffmpeg_bin, *ffmpeg_input(input_path), "-af", "volumedetect", "-f", "null", "-"]
    try:
        proc = run_ffmpeg(cmd)
    except (FileNotFoundError, RuntimeError):
        return None
    if proc.returncode != 0:
        return None
    match = _MAX_VOL_RE.search(proc.stderr)
    if match is None:
        return None
    return max(float(match.group(1)), PEAK_FLOOR_DBFS)
