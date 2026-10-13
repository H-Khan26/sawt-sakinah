/**
 * Active-position selector for the prayer-structure outline.
 *
 * Positions are server state (derived server-side from the markers); this is a pure lookup
 * that maps the current playhead time onto the position whose `[start, end)` contains it.
 * `PrayerOutline` calls it with the per-frame `sourceTime` slice and re-renders only when the
 * active position changes.
 */
import type { PrayerPosition } from "@/types/api";

/**
 * The `index` of the position whose half-open span `[start, end)` contains `time` (source
 * seconds), or `null` before the first one. The final position extends to +∞, so a time at or
 * past the end of the recording still counts as being in it.
 */
export function activePositionIndex(structure: PrayerPosition[], time: number): number | null {
  for (const [i, p] of structure.entries()) {
    const last = i === structure.length - 1;
    const end = last ? Number.POSITIVE_INFINITY : (p.end ?? Number.POSITIVE_INFINITY);
    if (time >= p.start && time < end) return p.index;
  }
  return null;
}
