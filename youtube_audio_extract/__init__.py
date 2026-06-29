"""Extract audio from YouTube videos as MP3 and strip silent segments."""

from .extract import extract_audio
from .silence import remove_silence
from .pipeline import youtube_to_clean_audio

__all__ = ["extract_audio", "remove_silence", "youtube_to_clean_audio"]
