"""Audio analysis that produces structured data without modifying the audio.

Detection answers "what and where" (silent regions, spoken phrases) and returns
contracts from ``youtube_audio_extract.models``. It must never write audio files --
that is the editing layer's job. See docs/audio/00-overview.md.
"""

from .silence import detect_silence

__all__ = ["detect_silence"]
