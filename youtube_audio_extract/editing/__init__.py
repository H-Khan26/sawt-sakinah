"""Audio transformations -- the only layer that writes new audio files.

Editing consumes detection output (or thresholds) and renders a new file. Detection
and analysis never live here. See docs/audio/00-overview.md and 04-editing-and-export.md.
"""

from .render import render
from .silence import remove_silence

__all__ = ["remove_silence", "render"]
