/**
 * What the cut tool's actions act on, as pure reads of the selection state: the pending in/out
 * range, the cut range selected on the waveform, and how much audio a cut or a restore of them
 * would change. The Cut panel reads them to label its buttons; `useCutCommands` reads them to act.
 */
import { MIN_CUT_DURATION, type Span, coveredDuration, cutKey } from "./cutEdl";

/** Audio a restore brings back: the source span to restore and its cut seconds. */
export interface RestoreTarget {
  span: Span;
  seconds: number;
  /** Whether the span is the pending selection (else the selected cut range). */
  pending: boolean;
}

/** The pending in/out range as an ordered span, or null when unset or shorter than a cut. */
export function pendingSpan(start: number | null, end: number | null): Span | null {
  if (start == null || end == null || Math.abs(end - start) < MIN_CUT_DURATION) return null;
  return [Math.min(start, end), Math.max(start, end)];
}

/** The merged cut range whose key is in `selectedIds`, or null. */
export function selectedCutSpan(cutSpans: Span[], selectedIds: Set<string>): Span | null {
  if (selectedIds.size === 0) return null;
  return cutSpans.find((span) => selectedIds.has(cutKey(span))) ?? null;
}

/** Seconds of `span` not yet cut — what cutting it removes. */
export const cutGain = (cutSpans: Span[], [a, b]: Span): number =>
  b - a - coveredDuration(cutSpans, a, b);

/**
 * What Restore brings back: the cut audio under the pending selection, or else the whole selected
 * cut range. Null when neither holds any cut audio.
 */
export function restoreTarget(
  cutSpans: Span[],
  pending: Span | null,
  selectedCut: Span | null,
): RestoreTarget | null {
  if (pending) {
    const seconds = coveredDuration(cutSpans, pending[0], pending[1]);
    if (seconds >= MIN_CUT_DURATION) return { span: pending, seconds, pending: true };
  }
  if (selectedCut) {
    return { span: selectedCut, seconds: selectedCut[1] - selectedCut[0], pending: false };
  }
  return null;
}
