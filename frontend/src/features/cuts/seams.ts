/**
 * Where each removed range sits on the waveform's timeline. A cut's *seam* is its start projected
 * through the `TimeMap`: in the collapsed view the join point the cut audio was taken out at, in
 * the full view the start of the drawn range. Stepping between cuts moves the playhead from seam
 * to seam; anything drawn at the joins reads the same positions.
 */
import type { TimeMap } from "@/features/waveform/timeMap";
import { formatClockPrecise } from "@/lib/time";
import type { Span } from "./cutEdl";

/** A merged cut range and where it sits on the edited timeline (seconds). */
export interface CutSeam {
  span: Span;
  /** The seam: the range's start on the timeline. */
  at: number;
  /** The range's end on the timeline; equal to `at` in the collapsed view. */
  to: number;
}

/** Seams this close (seconds) to the playhead count as at it, so a step moves past them. */
const AT_EPSILON = 0.01;

/**
 * While playing, a cut the playhead passed less than this long ago (seconds) still counts as at
 * it. Stepping back to a cut lands on its start, which playback skips at once to its end, so
 * repeated steps back would otherwise keep landing on the same cut.
 */
const PLAYING_BACK_SLOP = 0.75;

/** A seam chip's text: the removed length, `−4.2 s`, or `−1:05.3` from a minute up. */
export function removedLabel([start, end]: Span): string {
  const seconds = end - start;
  return `−${seconds < 60 ? `${seconds.toFixed(1)} s` : formatClockPrecise(seconds)}`;
}

/** Where a range sits in the original recording, e.g. `12:34.2–12:38.4`. */
export const originalRange = ([start, end]: Span): string =>
  `${formatClockPrecise(start)}–${formatClockPrecise(end)}`;

/** The seam of every merged cut range in `cutSpans`, in order. */
export const cutSeams = (cutSpans: Span[], timeMap: TimeMap): CutSeam[] =>
  cutSpans.map((span) => ({
    span,
    at: timeMap.toEdited(span[0]),
    to: timeMap.toEdited(span[1]),
  }));

/**
 * The nearest cut after (`1`) the edited time `at`, or the nearest one wholly before it (`-1`),
 * or null if none. Stepping back from inside a drawn range, or while `playing` from just past
 * one, moves on to the cut before it.
 */
export function adjacentSeam(
  seams: CutSeam[],
  at: number,
  direction: -1 | 1,
  playing = false,
): CutSeam | null {
  if (direction > 0) return seams.find((seam) => seam.at > at + AT_EPSILON) ?? null;
  const before = at - (playing ? PLAYING_BACK_SLOP : AT_EPSILON);
  for (let i = seams.length - 1; i >= 0; i--) {
    if (seams[i].to < before) return seams[i];
  }
  return null;
}
