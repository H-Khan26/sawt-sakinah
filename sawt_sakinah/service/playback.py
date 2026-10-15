"""A seek-accurate playback copy of a recording for the editor.

Chromium seeks an MP3 with FFmpeg's fast seek, which estimates the byte offset from the
Xing table of contents. On a long VBR MP3 the audio heard after a seek can sit many seconds
from the reported ``currentTime``, and every cut is authored against that clock. Copying
the same MP3 frames into an MP4 container gives the browser a per-frame index, so seeks
land on the right frame. The audio is bit-identical, the edit list keeps the encoder
delay, and the copy takes seconds.

The copy is a derived cache beside ``waveform.json``, built on first request. The source
never changes after import, so an existing copy is always current. Export still renders
from the source.
"""

from __future__ import annotations

import threading
from pathlib import Path

from ..ffmpeg import run_ffmpeg
from ..fileio import part_path, replace_file
from ..proc import ffmpeg_input

PLAYBACK_MEDIA_TYPE = "audio/mp4"

# A remux only reads and rewrites the file, so it finishes in seconds even for hours of audio.
_REMUX_TIMEOUT_SEC = 300.0

# Serializes remuxes: the browser's parallel range requests wait for one copy instead of
# each starting their own. Remuxes are rare and short, so one lock serves every project.
_lock = threading.Lock()


def ensure_playback_copy(source: Path, dest: Path, *, ffmpeg_bin: str) -> Path:
    """Return ``dest``, first remuxing ``source`` into it if it does not exist yet.

    Raises:
        FileNotFoundError: If ffmpeg or ``source`` is missing.
        RuntimeError: If ffmpeg fails or times out.
    """
    if dest.exists():
        return dest
    with _lock:
        if dest.exists():
            return dest
        partial = part_path(dest)
        cmd = [ffmpeg_bin, "-y", *ffmpeg_input(source), "-vn", "-c:a", "copy"]
        cmd += ["-movflags", "+faststart", "-f", "mp4", str(partial)]
        try:
            proc = run_ffmpeg(cmd, timeout=_REMUX_TIMEOUT_SEC)
            if proc.returncode != 0:
                raise RuntimeError(
                    f"FFmpeg remux failed (exit {proc.returncode}):\n{proc.stderr.strip()}"
                )
            replace_file(partial, dest)
        finally:
            try:
                partial.unlink(missing_ok=True)
            except OSError:
                pass  # the startup sweep removes partial files
    return dest
