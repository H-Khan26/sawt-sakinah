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
