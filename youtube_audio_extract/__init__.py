"""Extract audio from YouTube videos as MP3, detect silence, and edit audio.

Layers (see docs/audio/):
  extract_audio        -- extraction: YouTube URL -> mp3
  detect_silence       -- detection: audio -> structured silent regions (no mutation)
  remove_silence       -- editing: audio -> new audio with silence removed
  youtube_to_clean_audio -- convenience pipeline chaining the above
"""

from .extract import extract_audio
from .detection import detect_silence
from .silence import remove_silence
from .pipeline import youtube_to_clean_audio
from .models import SilenceSegment

__all__ = [
    "extract_audio",
    "detect_silence",
    "remove_silence",
    "youtube_to_clean_audio",
    "SilenceSegment",
]
