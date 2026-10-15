"""Audio analysis that produces structured data without modifying the audio.

Detection answers "what and where" (silent regions, the recited surahs) and returns
contracts from ``sawt_sakinah.models``. It must never write audio files --
that is the editing layer's job. See docs/audio/00-overview.md.
"""

from .silence import detect_silence
from .surahs import match_surahs

__all__ = ["detect_silence", "match_surahs"]
