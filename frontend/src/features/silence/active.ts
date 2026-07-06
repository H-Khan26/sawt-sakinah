/**
 * Projection of detected silences onto the *currently-active* (uncut) timeline.
 *
 * Detection is pure analysis of the source — `project.silences` never changes on an edit — but
 * a detected silence that falls inside audio the user has manually cut is no longer part of the
 * recitation and must not display or be actionable. `activeSilences` clips each detected span to
 * the parts still surviving. Because it is a pure projection of (silences, ops), it updates live
 * whether the cut was made before or after detection, and independently of whether deleted
 * regions are shown on the waveform.
 *
 * A silence's *own* removal (a `cut` matching a silence span) must NOT clip it — removed silences
 * stay listed, struck through, so they can be restored. We tell the two apart by geometry rather
 * than by exact-key matching (which breaks once a silence has been clipped): every silence
 * removal, whole or already-clipped, lies within the detected-silence union, so only cut spans
 * that extend *outside* that union — real content deletions — are used to clip.
 */
import type { EditOperation, SilenceSegment } from "@/types/api";

/** Surviving silence at or below this length (seconds) after clipping is a sliver — dropped. */
const MIN_ACTIVE_SILENCE = 0.01;

type Span = [number, number];

/** Merge overlapping/adjacent spans into sorted, non-overlapping intervals. */
function mergeSpans(spans: Span[]): Span[] {
  const sorted = spans.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const merged: Span[] = [];
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** Whether `[a, b]` lies entirely within one span of the (merged, sorted) `union`. */
function containedIn(a: number, b: number, union: Span[]): boolean {
  return union.some(([c, d]) => c <= a && b <= d);
}

/** Subtract `cuts` (merged, sorted) from `[a, b]`; returns the surviving sub-intervals. */
function subtract(a: number, b: number, cuts: Span[]): Span[] {
  const result: Span[] = [];
  let cursor = a;
  for (const [cs, ce] of cuts) {
    if (ce <= cursor || cs >= b) continue;
    if (cs > cursor) result.push([cursor, cs]);
    cursor = Math.max(cursor, ce);
    if (cursor >= b) break;
  }
  if (cursor < b) result.push([cursor, b]);
  return result;
}

/**
 * The detected silences clipped to the audio still active after manual cuts. A silence fully
 * inside a cut disappears; one straddling a cut edge is trimmed to its surviving part. Each
 * surviving piece is a fresh `SilenceSegment` keyed by its own (clipped) `start:end`, so
 * selection, removal, and restore all address the trimmed span. Returns the input array
 * unchanged when nothing clips, so identity is preserved for memoization.
 */
export function activeSilences(silences: SilenceSegment[], ops: EditOperation[]): SilenceSegment[] {
  if (silences.length === 0) return silences;

  const union = mergeSpans(silences.map((s): Span => [s.start, s.end]));
  const clipSpans = mergeSpans(
    ops
      .filter((op) => op.type === "cut")
      .map((op): Span => [op.start, op.end ?? op.start])
      .filter(([a, b]) => b > a && !containedIn(a, b, union)),
  );
  if (clipSpans.length === 0) return silences;

  const active: SilenceSegment[] = [];
  for (const seg of silences) {
    for (const [a, b] of subtract(seg.start, seg.end, clipSpans)) {
      if (b - a <= MIN_ACTIVE_SILENCE) continue;
      active.push(
        a === seg.start && b === seg.end ? seg : { ...seg, start: a, end: b, duration: b - a },
      );
    }
  }
  return active;
}
