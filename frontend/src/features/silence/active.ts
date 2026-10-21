/**
 * Projection of detected silences onto the *currently-active* (uncut) timeline.
 *
 * Detection is pure analysis of the source — `project.silences` never changes on an edit — but
 * a detected silence that falls inside audio the user has deleted is no longer part of the
 * recitation and must not display or be actionable. Because the projection is a pure function
 * of (silences, merged cut ranges), it updates live whether the cut was made before or after
 * detection, and independently of whether deleted regions are shown on the waveform.
 *
 * Removed audio is a set of merged ranges and its provenance is not stored, so the ranges are
 * told apart by geometry alone. A range that lies entirely within detected silence (the union
 * of the silences) is *silence removal*: a silence it covers whole stays listed, as removed, so
 * it can be restored from the list. Any other range is a *content cut*, even where it took
 * silence along with the recitation (say a silence removal that later merged with a marked
 * cut): a silence it covers whole is hidden, like any silence inside deleted recitation, and
 * its audio comes back only through the waveform's restore tools. A silence that no single
 * range covers whole is clipped to its uncovered part, and only that part is listed.
 *
 * So restoring a listed silence never brings back audio outside it: a removed one lies inside a
 * range of pure silence, and a clipped one covers no removed audio at all.
 */
import { type Span, TOUCH_EPSILON, firstEndingAfter, mergeSpans } from "@/lib/edl";
import type { SilenceSegment } from "@/types/api";
import { silenceKey } from "./regions";

/** Surviving silence at or below this length (seconds) after clipping is a sliver — dropped. */
const MIN_ACTIVE_SILENCE = 0.01;

/** The detected silences as the silence tool shows them against the current cuts. */
export interface SilenceView {
  /**
   * The silences still in the recitation, in detection order: each one untouched, removed
   * whole by silence removal, or clipped to its uncovered part. A clipped piece is a fresh
   * `SilenceSegment` keyed by its own `start:end`, so selection, removal and restore address
   * the clipped span.
   */
  active: SilenceSegment[];
  /** Keys of the `active` silences that silence removal took out (listed as removed). */
  removed: Set<string>;
  /** The `active` silences not removed: still heard. */
  kept: SilenceSegment[];
}

/**
 * Whether each merged cut range lies within the silence `union` — silence removal, not a content
 * cut. Both lists are sorted and disjoint, so one walk decides every range.
 */
export function silenceOnly(cutSpans: Span[], union: Span[]): boolean[] {
  let u = 0;
  return cutSpans.map(([a, b]) => {
    while (u < union.length && union[u][1] < a) u++;
    const span = union[u];
    return !!span && span[0] <= a + TOUCH_EPSILON && b <= span[1] + TOUCH_EPSILON;
  });
}

/**
 * Project `silences` onto the merged cut ranges `cutSpans` (sorted, disjoint); see the module
 * note for the rule. Each silence binary-searches the ranges it meets, so a pass stays cheap
 * with thousands of each. `active` and `kept` are the input array itself when no cut touches a
 * silence, so identity is preserved for memoization.
 */
export function silenceView(silences: SilenceSegment[], cutSpans: Span[]): SilenceView {
  if (silences.length === 0 || cutSpans.length === 0) {
    return { active: silences, removed: new Set(), kept: silences };
  }
  const pure = silenceOnly(cutSpans, mergeSpans(silences.map((s): Span => [s.start, s.end])));

  const active: SilenceSegment[] = [];
  const kept: SilenceSegment[] = [];
  const removed = new Set<string>();
  let changed = false;
  for (const seg of silences) {
    // The first range ending after the silence starts; only it can cover the whole silence.
    const first = firstEndingAfter(cutSpans, seg.start);
    const range = cutSpans[first];
    if (!range || range[0] >= seg.end) {
      active.push(seg);
      kept.push(seg);
      continue;
    }
    changed = true;
    if (range[0] <= seg.start + TOUCH_EPSILON && seg.end <= range[1] + TOUCH_EPSILON) {
      if (pure[first]) {
        active.push(seg);
        removed.add(silenceKey(seg));
      }
      continue;
    }
    // Clip to what no range covers.
    let cursor = seg.start;
    for (let i = first; i < cutSpans.length && cutSpans[i][0] < seg.end; i++) {
      const [c, d] = cutSpans[i];
      if (c - cursor > MIN_ACTIVE_SILENCE) {
        const piece = { ...seg, start: cursor, end: c, duration: c - cursor };
        active.push(piece);
        kept.push(piece);
      }
      cursor = Math.max(cursor, d);
    }
    if (seg.end - cursor > MIN_ACTIVE_SILENCE) {
      const piece = { ...seg, start: cursor, end: seg.end, duration: seg.end - cursor };
      active.push(piece);
      kept.push(piece);
    }
  }
  return changed ? { active, removed, kept } : { active: silences, removed, kept: silences };
}
