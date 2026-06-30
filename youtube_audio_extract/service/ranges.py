"""HTTP Range support for audio streaming/seeking.

No ``Range`` header -> a plain ``FileResponse``. With a ``Range`` header -> a ``206``
``StreamingResponse`` that seeks and yields fixed-size chunks; an unsatisfiable range
yields ``416``. Used by the audio and export-download endpoints so the frontend's
waveform/player can seek without downloading the whole file.
"""

from __future__ import annotations

import mimetypes
from pathlib import Path
from typing import Iterator, Optional

from fastapi import Response
from fastapi.responses import FileResponse, StreamingResponse

CHUNK_SIZE = 64 * 1024

_AUDIO_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".flac": "audio/flac",
}


def media_type_for(path: str | Path) -> str:
    ext = Path(path).suffix.lower()
    return (
        _AUDIO_TYPES.get(ext)
        or mimetypes.guess_type(str(path))[0]
        or "application/octet-stream"
    )


def _parse_range(header: str, size: int) -> Optional[tuple[int, int]]:
    """Parse a single-range ``bytes=`` header into inclusive ``(start, end)``.

    Returns ``None`` for a malformed or unsatisfiable range (the caller answers 416).
    Supports ``bytes=start-``, ``bytes=start-end``, and the ``bytes=-suffix`` form.
    """
    if not header or not header.startswith("bytes="):
        return None
    spec = header[len("bytes="):].split(",")[0].strip()
    if "-" not in spec:
        return None
    start_s, end_s = spec.split("-", 1)
    try:
        if start_s == "":
            length = int(end_s)
            if length <= 0:
                return None
            start = max(0, size - length)
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
    except ValueError:
        return None
    if start > end or start >= size or start < 0:
        return None
    return start, min(end, size - 1)


def ranged_file_response(
    path: str | Path,
    range_header: Optional[str],
    media_type: Optional[str] = None,
    filename: Optional[str] = None,
) -> Response:
    """Serve ``path`` honoring an optional ``Range`` header (200, 206, or 416)."""
    path = Path(path)
    media_type = media_type or media_type_for(path)
    size = path.stat().st_size

    if not range_header:
        return FileResponse(path, media_type=media_type, filename=filename)

    parsed = _parse_range(range_header, size)
    if parsed is None:
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"},
        )

    start, end = parsed
    length = end - start + 1

    def body() -> Iterator[bytes]:
        with open(path, "rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(CHUNK_SIZE, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Content-Range": f"bytes {start}-{end}/{size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
    }
    return StreamingResponse(
        body(), status_code=206, media_type=media_type, headers=headers
    )
