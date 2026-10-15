/**
 * Generic helpers over EDL ops and source-time spans, shared by the API layer and the editing
 * features: structural equality of op arrays, and the span algebra (merge, subtract, coverage)
 * the cut tool builds its semantics on (see `features/cuts/cutEdl.ts`). Lists of spans are
 * sorted and disjoint wherever a helper says so, which lets lookups binary-search them.
 */
import type { EditOperation } from "@/types/api";

/** A source-time range `[start, end]` in seconds. */
export type Span = [number, number];

/** Ranges closer than this (seconds) count as touching: they merge, and coverage tolerates it. */
export const TOUCH_EPSILON = 1e-6;

/** Structural equality for op arrays. */
export function sameOps(a: EditOperation[], b: EditOperation[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((op, i) => {
    const o = b[i];
    return op.type === o.type && op.start === o.start && op.end === o.end;
  });
}

/** Total seconds of `spans`. */
export const spanTotal = (spans: Span[]): number => spans.reduce((sum, [a, b]) => sum + (b - a), 0);

/**
 * The first index in `[0, length)` for which `test` holds, or `length` if none does. `test` must
 * be false up to some index and true from it on (e.g. "ends after t" over sorted, disjoint spans).
 */
export function firstIndex(length: number, test: (i: number) => boolean): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (test(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Index of the first of the sorted, disjoint `spans` that ends after `t`, or `spans.length`. */
export const firstEndingAfter = (spans: Span[], t: number): number =>
  firstIndex(spans.length, (i) => spans[i][1] > t);

/** Merge spans into sorted, disjoint ranges; overlapping or touching spans join, empty ones drop. */
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const merged: Span[] = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1] + TOUCH_EPSILON) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/**
 * Subtract `remove` from `spans` (both sorted and disjoint). A span `remove` doesn't touch is
 * kept as is; a trimmed or split piece shorter than `minPiece` is dropped. One walk over both.
 */
export function subtractSpans(spans: Span[], remove: Span[], minPiece = 0): Span[] {
  const result: Span[] = [];
  let first = 0;
  for (const [a, b] of spans) {
    while (first < remove.length && remove[first][1] <= a) first++;
    const pieces: Span[] = [];
    let cursor = a;
    for (let j = first; j < remove.length && remove[j][0] < b; j++) {
      const [c, d] = remove[j];
      if (c > cursor) pieces.push([cursor, c]);
      cursor = Math.max(cursor, d);
      if (cursor >= b) break;
    }
    if (cursor < b) pieces.push([cursor, b]);
    const untouched = pieces.length === 1 && pieces[0][0] === a && pieces[0][1] === b;
    result.push(...(untouched ? pieces : pieces.filter(([c, d]) => d - c >= minPiece)));
  }
  return result;
}

/** Seconds of `[start, end]` that the sorted, disjoint `ranges` cover. */
export function coveredDuration(ranges: Span[], start: number, end: number): number {
  let total = 0;
  for (let i = firstEndingAfter(ranges, start); i < ranges.length; i++) {
    const [a, b] = ranges[i];
    if (a >= end) break;
    total += Math.max(0, Math.min(b, end) - Math.max(a, start));
  }
  return total;
}
