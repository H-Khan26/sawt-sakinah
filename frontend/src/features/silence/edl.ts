/**
 * Pure mapping between silence segments and EDL operations, plus small tallies for the UI.
 * Removing a silence span `[s, e]` is a non-destructive `cut` op against the original
 * timeline; the backend applies cuts (with boundary fades) only at export. The UI never
 * mutates loaded audio.
 */
import type { EditOperation, SilenceSegment } from "@/types/api";

/** The cut operation that removes a given silence span. */
export const cutForSilence = (seg: SilenceSegment): EditOperation => ({
  type: "cut",
  start: seg.start,
  end: seg.end,
});

/** Whether `ops` already contains a cut covering exactly this silence span. */
export const isSilenceCut = (ops: EditOperation[], seg: SilenceSegment): boolean =>
  ops.some((op) => op.type === "cut" && op.start === seg.start && op.end === seg.end);

/** Append cut ops for `segs` (skipping any already cut). Returns a new array (or the same). */
export function addCuts(ops: EditOperation[], segs: SilenceSegment[]): EditOperation[] {
  const additions = segs.filter((seg) => !isSilenceCut(ops, seg)).map(cutForSilence);
  return additions.length ? [...ops, ...additions] : ops;
}

/** Remove cut ops matching `segs`. Returns a new array. */
export function removeCuts(ops: EditOperation[], segs: SilenceSegment[]): EditOperation[] {
  const drop = new Set(segs.map((seg) => `${seg.start}:${seg.end}`));
  return ops.filter((op) => !(op.type === "cut" && drop.has(`${op.start}:${op.end}`)));
}

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

/** Removed-audio tally from the EDL's cut ops (count + total seconds). */
export function cutStats(ops: EditOperation[]): EditTally {
  const cuts = ops.filter((op) => op.type === "cut");
  return {
    count: cuts.length,
    totalDuration: cuts.reduce((sum, op) => sum + ((op.end ?? op.start) - op.start), 0),
  };
}
