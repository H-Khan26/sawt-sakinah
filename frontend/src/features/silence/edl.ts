/**
 * Mapping between silence segments and the EDL's removed ranges, plus small tallies for the UI.
 * Removing a silence cuts its span `[s, e]` (a union with the removed audio); restoring it
 * subtracts that span again. Both are non-destructive edits against the original timeline;
 * the backend applies cuts (with boundary fades) only at export. The UI never mutates loaded
 * audio. Which silences count as removed is decided by `silenceView` (see `active.ts`).
 */
import { cutRanges, restoreRanges } from "@/features/cuts/cutEdl";
import type { Span } from "@/lib/edl";
import type { EditOperation, SilenceSegment } from "@/types/api";

const spanOf = (seg: SilenceSegment): Span => [seg.start, seg.end];

/** Cut the spans of `segs`. */
export const removeSilences = (ops: EditOperation[], segs: SilenceSegment[]): EditOperation[] =>
  cutRanges(ops, segs.map(spanOf));

/**
 * Restore the spans of `segs`, trimming or splitting the cut ranges they overlap. Given silences
 * `silenceView` lists as removed, each lies inside a range of pure silence, so only silence
 * comes back.
 */
export const restoreSilences = (ops: EditOperation[], segs: SilenceSegment[]): EditOperation[] =>
  restoreRanges(ops, segs.map(spanOf));

export interface EditTally {
  count: number;
  totalDuration: number;
}

/** Detected-silence tally (count + total seconds). */
export function silenceStats(silences: SilenceSegment[]): EditTally {
  return {
    count: silences.length,
    totalDuration: silences.reduce((sum, s) => sum + s.duration, 0),
  };
}
