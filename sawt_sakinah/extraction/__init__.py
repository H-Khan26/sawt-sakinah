"""YouTube URL -> local audio file + metadata. Side-effecting (network, filesystem).

This layer downloads and describes audio; it performs no analysis or editing. Its job
is to hand downstream layers an :class:`AudioSource`. See docs/audio/01-extraction.md.
"""

from .extractor import extract_audio

__all__ = ["extract_audio"]
