"""Acquire audio -> local file + metadata. Side-effecting (network, filesystem).

Two acquisition front-ends hand downstream layers an :class:`AudioSource`: a link to a post
(YouTube, Instagram, X, Facebook) via :func:`extract_audio` (yt-dlp), or a user upload via
:func:`import_file` (local file).
Both converge on the shared :func:`~.finalize.finalize_source` tail. This layer describes
audio; it performs no analysis or editing. See docs/audio/01-extraction.md.
"""

from .extractor import extract_audio
from .importer import import_file

__all__ = ["extract_audio", "import_file"]
