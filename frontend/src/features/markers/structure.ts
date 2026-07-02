/**
 * Active-position selector for the prayer-structure outline.
 *
 * Positions are server state (derived server-side from the markers); this is a pure lookup
 * that maps the current playhead time onto the position whose `[start, end)` contains it.
 * `PrayerStructurePanel` calls it with the per-frame `currentTime` slice so only that panel
 * re-renders as playback advances.
 */
import type { PrayerPosition } from "@/types/api";

/**
 * The `index` of the position whose half-open span `[start, end)` contains `time`, or
 * `null` when none does. The final, open-ended position (`end === null`) extends to +∞.
 */
export function activePositionIndex(structure: PrayerPosition[], time: number): number | null {
  for (const p of structure) {
    const end = p.end ?? Number.POSITIVE_INFINITY;
    if (time >= p.start && time < end) return p.index;
  }
  return null;
}
