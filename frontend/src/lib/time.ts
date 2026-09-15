/** Format a duration in seconds as `m:ss` (e.g. `3:07`). Negative/NaN clamps to `0:00`. */
export function formatClock(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Format seconds as `m:ss.d` with one decimal (e.g. `3:07.4`) for the editing readouts,
 * where sub-second precision matters when marking cut points. Negative/NaN clamps to `0:00.0`.
 */
export function formatClockPrecise(seconds: number): string {
  const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const mins = Math.floor(t / 60);
  const secs = t - mins * 60;
  return `${mins}:${secs.toFixed(1).padStart(4, "0")}`;
}

/**
 * Format a timeline-axis tick for the waveform ruler. Compact and fixed-width so labels
 * don't crowd or clip as values grow across a long file: anything an hour or longer renders
 * as `h:mm` (dropping the redundant `:ss` on whole-minute ticks), so a 174-minute mark reads
 * `2:54` instead of `174:00` and every coarse label is a uniform 4 chars. Ticks that land on
 * a sub-minute boundary (zoomed in, where labels are far apart) keep the seconds component.
 * Shorter files stay in `m:ss`, matching the transport clock. `durationSec` is the total
 * clip length, used to pick the mode for the whole axis (not per-label, to avoid a jarring
 * width change at the 1-hour boundary).
 */
export function formatTimelineTime(seconds: number, durationSec: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (durationSec >= 3600) {
    const hm = `${h}:${m.toString().padStart(2, "0")}`;
    return secs === 0 ? hm : `${hm}:${secs.toString().padStart(2, "0")}`;
  }
  return `${m}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Parse a user-typed timestamp into seconds, or `null` if it isn't a valid time.
 * Accepts bare seconds (`83`, `83.4`) or `m:ss(.d)` (`1:23`, `1:23.4`). The seconds part
 * of an `m:ss` value must be in `[0, 60)`.
 */
export function parseClock(input: string): number | null {
  const s = input.trim();
  if (!s) return null;
  if (s.includes(":")) {
    const parts = s.split(":");
    if (parts.length !== 2) return null;
    const mins = Number(parts[0]);
    const secs = Number(parts[1]);
    if (!Number.isFinite(mins) || !Number.isFinite(secs)) return null;
    if (mins < 0 || secs < 0 || secs >= 60) return null;
    return mins * 60 + secs;
  }
  const v = Number(s);
  return Number.isFinite(v) && v >= 0 ? v : null;
}
