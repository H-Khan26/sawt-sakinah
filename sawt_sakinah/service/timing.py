"""Wall-clock timing of a job's stages, read from the progress reports it already sends.

Workers report ``{"stage": ...}`` as they move through their steps. :class:`StageTimer`
sits between a worker and the registry's progress callback, notes when the reported stage
changes, and at the end logs a per-stage breakdown and returns it for the job result.
Time before the first report counts as ``setup``. Time after a ``done`` report and before
the next stage belongs to no stage and shows up as ``other``, so gaps between steps stay
visible instead of inflating a neighbour.
"""

from __future__ import annotations

import logging
import time
from typing import Callable, Optional

_log = logging.getLogger(__name__)

SETUP = "setup"
_MB = 1024 * 1024


class StageTimer:
    """A progress callback that forwards every report and times the stages they name."""

    def __init__(self, progress: Callable[[dict], None]) -> None:
        self._progress = progress
        self._started = time.monotonic()
        self._stage: Optional[str] = SETUP
        self._stage_started = self._started
        self._seconds: dict[str, float] = {}  # in the order stages first ran
        self._downloaded_bytes: Optional[int] = None

    def __call__(self, payload: dict) -> None:
        stage = payload.get("stage")
        if isinstance(stage, str):
            self.mark(stage)
        downloaded = payload.get("downloaded_bytes")
        if isinstance(downloaded, (int, float)):
            self._downloaded_bytes = int(downloaded)
        self._progress(payload)

    def mark(self, stage: str) -> None:
        """Start timing ``stage``; ``done`` ends the current stage without starting one.

        Also used directly for steps that send no progress report. A stage that runs
        again later adds to its earlier time.
        """
        if stage == self._stage:
            return
        now = time.monotonic()
        self._close(now)
        self._stage = None if stage == "done" else stage
        self._stage_started = now

    def _close(self, now: float) -> None:
        if self._stage is not None:
            elapsed = now - self._stage_started
            self._seconds[self._stage] = self._seconds.get(self._stage, 0.0) + elapsed

    def finish(self, label: str, audio_sec: Optional[float] = None) -> dict:
        """End the current stage, log the breakdown and return it.

        ``audio_sec`` (the recording's length) adds how many times faster than realtime
        the whole job ran.
        """
        now = time.monotonic()
        self._close(now)
        self._stage = None
        total = now - self._started
        summary: dict = {
            "stages": {name: round(sec, 2) for name, sec in self._seconds.items()},
            "other_sec": round(max(0.0, total - sum(self._seconds.values())), 2),
            "total_sec": round(total, 2),
        }
        download_sec = self._seconds.get("download")
        if self._downloaded_bytes and download_sec:
            summary["download_mb_per_sec"] = round(self._downloaded_bytes / _MB / download_sec, 2)
        if audio_sec and total > 0:
            summary["realtime_factor"] = round(audio_sec / total, 1)
        _log.info("%s timings: %s", label, _describe(summary, audio_sec))
        return summary


def _describe(summary: dict, audio_sec: Optional[float]) -> str:
    """One log line, e.g. ``setup 1.2s · download 22.3s (2.8 MB/s) · ... · total 114.2s``."""
    parts = []
    for name, sec in summary["stages"].items():
        part = f"{name} {sec:.1f}s"
        if name == "download" and "download_mb_per_sec" in summary:
            part += f" ({summary['download_mb_per_sec']:.1f} MB/s)"
        parts.append(part)
    parts.append(f"other {summary['other_sec']:.1f}s")
    parts.append(f"total {summary['total_sec']:.1f}s")
    line = " · ".join(parts)
    if audio_sec:
        line += f" for {audio_sec:.0f}s of audio"
        if "realtime_factor" in summary:
            line += f" ({summary['realtime_factor']:g}x realtime)"
    return line


__all__ = ["StageTimer"]
