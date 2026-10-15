/**
 * Pure helpers over the EDL's `cut` ops, which together describe the removed audio as a set of
 * non-overlapping time ranges (source seconds).
 *
 * The cut ops are kept normalized: sorted, with overlapping or touching ranges merged and
 * clamped to the source, so removed audio is one set of ranges however it was made (silence
 * removal, a marked range, keep-only). Cutting is a union with that set; restoring subtracts
 * from it, which may trim a range or split it in two. Every edit returns normalized ops, so a
 * legacy EDL with overlapping cuts is normalized by its first edit. The other ops
 * (keep/fade/marker, and any open-ended cut) pass through untouched after the cuts. The server
 * stores the same normal form (`normalize_cuts` in `models/edl.py`).
 */
import type { EditOperation } from "@/types/api";

/** A source-time range `[start, end]` in seconds. */
export type Span = [number, number];

/** Ignore ranges shorter than this (seconds) — a stray double-tap of I/O, not a real cut. */
export const MIN_CUT_DURATION = 0.02;

/** Ranges closer than this (seconds) count as touching: they merge, and coverage tolerates it. */
export const TOUCH_EPSILON = 1e-6;

/** Prefix of a cut range's selection key; silence keys (`start:end`) never start with it. */
export const CUT_KEY_PREFIX = "cut:";

/**
 * Selection key of a merged cut range on the waveform (`cut:start:end`). It names the range's
 * exact bounds, so an edit that moves either bound gives the range a new key.
 */
export const cutKey = ([start, end]: Span): string => `${CUT_KEY_PREFIX}${start}:${end}`;

/** Undo label for an edit over `seconds` of audio, e.g. `Cut 4.2 s`. */
export const durationLabel = (verb: string, seconds: number): string =>
  `${verb} ${Math.abs(seconds).toFixed(1)} s`;

const ordered = (a: number, b: number): Span => [Math.min(a, b), Math.max(a, b)];

/** A cut with both ends — the kind that removes a range. */
const isRangeCut = (op: EditOperation): boolean => op.type === "cut" && op.end != null;

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
 * kept as is; a trimmed or split piece shorter than `minPiece` is dropped.
 */
export function subtractSpans(spans: Span[], remove: Span[], minPiece = 0): Span[] {
  const result: Span[] = [];
  for (const [a, b] of spans) {
    const pieces: Span[] = [];
    let cursor = a;
    for (const [c, d] of remove) {
      if (d <= cursor || c >= b) continue;
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
  for (const [a, b] of ranges) total += Math.max(0, Math.min(b, end) - Math.max(a, start));
  return total;
}

/** Whether `[start, end]` lies entirely within one of the sorted, disjoint `ranges`. */
export function isCovered(ranges: Span[], start: number, end: number): boolean {
  return ranges.some(([a, b]) => a <= start + TOUCH_EPSILON && end <= b + TOUCH_EPSILON);
}

/**
 * The removed audio: every `cut` range merged into sorted, disjoint spans. Works on a legacy
 * (unnormalized) EDL too, so counts and totals never double-count. It is what playback skips
 * and what the collapsed view drops, and mirrors the server-side merge in `editing/render.py`
 * so what you hear matches what you export.
 */
export function mergeCutSpans(ops: EditOperation[]): Span[] {
  return mergeSpans(ops.filter(isRangeCut).map((op): Span => [op.start, op.end as number]));
}

/** `ops` with its range cuts replaced by `spans` (sorted, disjoint), the other ops after them. */
function withCuts(ops: EditOperation[], spans: Span[]): EditOperation[] {
  return [
    ...spans.map(([start, end]): EditOperation => ({ type: "cut", start, end })),
    ...ops.filter((op) => !isRangeCut(op)),
  ];
}

/** Normalize the cut ranges of `ops`: merged, sorted, and clamped to `[0, duration]` if known. */
export function normalizeCuts(ops: EditOperation[], duration?: number): EditOperation[] {
  const hi = duration && duration > 0 ? duration : Number.POSITIVE_INFINITY;
  const clamped = mergeCutSpans(ops).map(([a, b]): Span => [Math.max(0, a), Math.min(hi, b)]);
  return withCuts(ops, mergeSpans(clamped));
}

/** Cut every range in `ranges`: their union with the removed audio. */
export function cutRanges(ops: EditOperation[], ranges: Span[]): EditOperation[] {
  const added = ranges.map(([a, b]) => ordered(a, b));
  return withCuts(ops, mergeSpans([...mergeCutSpans(ops), ...added]));
}

/** Cut `[start, end]` (either order). A range shorter than `MIN_CUT_DURATION` changes nothing. */
export function cutRange(ops: EditOperation[], start: number, end: number): EditOperation[] {
  const [a, b] = ordered(start, end);
  return cutRanges(ops, b - a < MIN_CUT_DURATION ? [] : [[a, b]]);
}

/**
 * Restore every range in `ranges`: subtract them from the removed audio, trimming or splitting
 * the ranges they overlap. A leftover sliver shorter than `MIN_CUT_DURATION` is restored too.
 */
export function restoreRanges(ops: EditOperation[], ranges: Span[]): EditOperation[] {
  const restored = mergeSpans(ranges.map(([a, b]) => ordered(a, b)));
  return withCuts(ops, subtractSpans(mergeCutSpans(ops), restored, MIN_CUT_DURATION));
}

/** Restore `[start, end]` (either order). */
export function restoreRange(ops: EditOperation[], start: number, end: number): EditOperation[] {
  return restoreRanges(ops, [[start, end]]);
}

/**
 * Trim everything outside `[start, end]` — "keep only this range". Expressed as cuts of the head
 * `[0, start]` and the tail `[end, duration]` rather than a `keep` op, so the whole live pipeline
 * (collapse map, playback skip, silence clipping) — which reasons over cut ranges — reflects it
 * without change. The render engine treats these cuts identically to a keep span.
 */
export function keepOnly(
  ops: EditOperation[],
  start: number,
  end: number,
  duration: number,
): EditOperation[] {
  const [a, b] = ordered(start, end);
  return cutRange(cutRange(ops, 0, Math.max(0, a)), Math.min(duration, b), duration);
}

/** Structural equality for op arrays. */
export function sameOps(a: EditOperation[], b: EditOperation[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((op, i) => {
    const o = b[i];
    return op.type === o.type && op.start === o.start && op.end === o.end;
  });
}
