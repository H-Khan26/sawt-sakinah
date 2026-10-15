/**
 * Projection of detected silences onto the *currently-active* (uncut) timeline.
 *
 * Detection is pure analysis of the source — `project.silences` never changes on an edit — but
 * a detected silence that falls inside audio the user has deleted is no longer part of the
 * recitation and must not display or be actionable. Because `activeSilences` is a pure
 * projection of (silences, ops), it updates live whether the cut was made before or after
 * detection, and independently of whether deleted regions are shown on the waveform.
 *
 * A silence's *own* removal must NOT hide it — removed silences stay listed, struck through, so
 * they can be restored. Removed audio is a set of merged ranges, so a removed silence may have
 * merged with a neighbouring content cut; the two are told apart by geometry. A range's ends
 * that fall inside detected silence are silence removal; the rest, its *core*, is a content
 * deletion. A silence inside a core is gone along with the recitation around it and is hidden.
 * A silence covered at a range's edge borders kept audio, so it stays listed (as removed). A
 * silence only partly covered is clipped to its uncovered part.
 */
import { mergeCutSpans } from "@/features/cuts/cutEdl";
import { type Span, TOUCH_EPSILON, isCovered, mergeSpans, subtractSpans } from "@/lib/edl";
import type { EditOperation, SilenceSegment } from "@/types/api";

/** Surviving silence at or below this length (seconds) after clipping is a sliver — dropped. */
const MIN_ACTIVE_SILENCE = 0.01;

/**
 * The content-deletion core of cut range `[a, b]`: the range with any end that lies inside the
 * silence `union` pulled back to that silence's edge. Null when the range is all silence.
 */
function contentCore([a, b]: Span, union: Span[]): Span | null {
  let start = a;
  let end = b;
  for (const [c, d] of union) {
    if (c <= start + TOUCH_EPSILON && start < d) start = d;
    if (c < end && end <= d + TOUCH_EPSILON) end = c;
  }
  return end - start > TOUCH_EPSILON ? [start, end] : null;
}

/**
 * The detected silences that are still part of the recitation. A silence inside a deleted core
 * disappears; one covered at a cut range's edge stays as is (removed); one straddling a cut
 * edge is trimmed to its surviving part. Each trimmed piece is a fresh `SilenceSegment` keyed
 * by its own `start:end`, so selection, removal, and restore all address the trimmed span.
 * Returns the input array unchanged when nothing is hidden or trimmed, so identity is preserved
 * for memoization.
 */
export function activeSilences(silences: SilenceSegment[], ops: EditOperation[]): SilenceSegment[] {
  if (silences.length === 0) return silences;
  const cuts = mergeCutSpans(ops);
  if (cuts.length === 0) return silences;

  const union = mergeSpans(silences.map((s): Span => [s.start, s.end]));
  const cores = cuts.map((range) => contentCore(range, union));

  const active: SilenceSegment[] = [];
  let changed = false;
  for (const seg of silences) {
    const i = cuts.findIndex((range) => isCovered([range], seg.start, seg.end));
    if (i >= 0) {
      const core = cores[i];
      if (core && seg.start < core[1] && core[0] < seg.end) changed = true;
      else active.push(seg);
      continue;
    }
    const pieces = subtractSpans([[seg.start, seg.end]], cuts);
    if (pieces.length === 1 && pieces[0][0] === seg.start && pieces[0][1] === seg.end) {
      active.push(seg);
      continue;
    }
    changed = true;
    for (const [a, b] of pieces) {
      if (b - a > MIN_ACTIVE_SILENCE) active.push({ ...seg, start: a, end: b, duration: b - a });
    }
  }
  return changed ? active : silences;
}
