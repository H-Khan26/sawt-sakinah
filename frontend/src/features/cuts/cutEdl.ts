import { silenceKey } from "@/features/silence/regions";
/**
 * Pure mapping between manual cut ranges and EDL `cut` operations, plus the merged-span
 * helper that drives live playback skipping.
 *
 * A "manual cut" is any `cut` op that does *not* correspond to a detected silence span — i.e.
 * a range the user marked by hand (via the I/O keys or the timestamp inputs). Detected-silence
 * cuts stay owned by the silence feature; keeping the two disjoint lets each list manage only
 * its own rows while both render through the same EDL and the same undo history.
 */
import type { EditOperation, SilenceSegment } from "@/types/api";

/** Ignore ranges shorter than this (seconds) — a stray double-tap of I/O, not a real cut. */
export const MIN_CUT_DURATION = 0.02;

/** Prefix distinguishing a manual-cut selection key from a silence key in `selectedIds`. */
export const CUT_PREFIX = "cut:";

/** Stable selection key for a committed manual cut op (`cut:start:end`). */
export const cutKey = (op: EditOperation): string => `${CUT_PREFIX}${op.start}:${op.end}`;

/** The `cut` ops in `ops` that don't match any detected silence span (i.e. user-authored). */
export function manualCuts(ops: EditOperation[], silences: SilenceSegment[]): EditOperation[] {
  const silenceKeys = new Set(silences.map(silenceKey));
  return ops.filter((op) => op.type === "cut" && !silenceKeys.has(`${op.start}:${op.end}`));
}

/**
 * Append a `cut` op for `[start, end]` (normalized so start < end). Returns the same array
 * unchanged if the range is too short or an identical cut already exists.
 */
export function addCut(ops: EditOperation[], start: number, end: number): EditOperation[] {
  const a = Math.min(start, end);
  const b = Math.max(start, end);
  if (b - a < MIN_CUT_DURATION) return ops;
  if (ops.some((op) => op.type === "cut" && op.start === a && op.end === b)) return ops;
  return [...ops, { type: "cut", start: a, end: b }];
}

/** Drop the `cut` ops whose keys are in `keys` (a set of `cut:start:end`). Returns a new array. */
export function removeCutsByKey(ops: EditOperation[], keys: Set<string>): EditOperation[] {
  return ops.filter((op) => !(op.type === "cut" && keys.has(cutKey(op))));
}

/**
 * All `cut` spans (silence + manual) merged into sorted, non-overlapping `[start, end]`
 * intervals — what playback must skip over to preview the edited result. Mirrors the
 * server-side merge in `editing/render.py` so what you hear matches what you export.
 */
export function mergeCutSpans(ops: EditOperation[]): Array<[number, number]> {
  const spans = ops
    .filter((op) => op.type === "cut")
    .map((op): [number, number] => [op.start, op.end ?? op.start])
    .filter(([a, b]) => b > a)
    .sort((p, q) => p[0] - q[0]);

  const merged: Array<[number, number]> = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}
