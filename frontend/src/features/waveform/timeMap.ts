/**
 * Source <-> edited time mapping for the collapsed ("deleted portions hidden") waveform view.
 *
 * The whole editor works in *source* time — the EDL, surah passages, silences, and cut authoring are
 * all source seconds. Only the waveform *presentation* collapses cut spans out of the timeline.
 * A `TimeMap` is the bridge: it projects a source time onto the contiguous edited timeline that
 * the collapsed waveform draws, and inverts an edited time back to source for seeking.
 *
 * When deleted portions are shown (or there are no cuts) the map is the identity: edited time ==
 * source time, so the same rendering/seek code path serves both views. The kept-span math mirrors
 * the server-side `editing/render.py` (`_resolve_keeps` / `_remap_time`) so what you see collapsed
 * matches what export produces. Lookups binary-search the kept spans, so projecting every silence
 * or seam stays cheap with thousands of cuts.
 */
import { type Span, firstIndex } from "@/lib/edl";

export type { Span };

export interface TimeMap {
  /** True when edited time == source time (deleted portions shown, or nothing cut). */
  readonly identity: boolean;
  /** Length of the edited (collapsed) timeline in seconds. */
  readonly editedTotal: number;
  /** The surviving source spans, in order — what the collapsed waveform is built from. */
  readonly keptSpans: Span[];
  /** Project a source time onto the edited timeline (a cut interior maps to its join point). */
  toEdited(sourceT: number): number;
  /** Invert an edited time back to source time. */
  toSource(editedT: number): number;
  /** Whether a source time falls inside a cut (always false for the identity map). */
  isDeleted(sourceT: number): boolean;
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function identityMap(duration: number): TimeMap {
  const d = Math.max(0, duration);
  return {
    identity: true,
    editedTotal: d,
    keptSpans: [[0, d]],
    toEdited: (s) => clamp(s, 0, d),
    toSource: (e) => clamp(e, 0, d),
    isDeleted: () => false,
  };
}

/**
 * Build a `TimeMap` for the merged cut ranges `cutSpans` (sorted, disjoint) against a source of
 * `duration` seconds. `collapsed` false (or a source with no cuts / zero duration) yields the
 * identity map.
 */
export function buildTimeMap(cutSpans: Span[], duration: number, collapsed: boolean): TimeMap {
  if (!collapsed || duration <= 0) return identityMap(duration);

  const cuts = cutSpans
    .map(([a, b]): Span => [clamp(a, 0, duration), clamp(b, 0, duration)])
    .filter(([a, b]) => b > a);
  if (cuts.length === 0) return identityMap(duration);

  // Kept spans = the complement of the (merged, sorted) cuts within [0, duration].
  const kept: Span[] = [];
  let cursor = 0;
  for (const [a, b] of cuts) {
    if (a > cursor) kept.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < duration) kept.push([cursor, duration]);
  if (kept.length === 0) return identityMap(duration); // everything cut — nothing to collapse to

  // Edited time at the start and the end of each kept span.
  const offsets: number[] = [];
  const editedEnds: number[] = [];
  let acc = 0;
  for (const [a, b] of kept) {
    offsets.push(acc);
    acc += b - a;
    editedEnds.push(acc);
  }
  const editedTotal = acc;

  // The first kept span ending at or after source time `s`.
  const spanAt = (s: number) => firstIndex(kept.length, (i) => kept[i][1] >= s);

  const toEdited = (sourceT: number): number => {
    const s = clamp(sourceT, 0, duration);
    const i = spanAt(s);
    if (i === kept.length) return editedTotal;
    const [a] = kept[i];
    return s < a ? offsets[i] : offsets[i] + (s - a); // inside a cut -> the join after it
  };

  const toSource = (editedT: number): number => {
    const e = clamp(editedT, 0, editedTotal);
    const i = firstIndex(kept.length, (k) => editedEnds[k] >= e);
    return i === kept.length ? kept[kept.length - 1][1] : kept[i][0] + (e - offsets[i]);
  };

  const isDeleted = (sourceT: number): boolean => {
    const span = kept[spanAt(sourceT)];
    return !span || sourceT < span[0];
  };

  return { identity: false, editedTotal, keptSpans: kept, toEdited, toSource, isDeleted };
}
