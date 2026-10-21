/**
 * Snapping on the waveform: a click or a dragged edge that comes within `SNAP_PX` on screen of
 * an edge (a surah passage's start or end, a cut range's edge or, in the collapsed view, its
 * join, the selection's start or end, and the start and end of the timeline) latches on to it.
 * The reach is in pixels, so it covers seconds at the fitted zoom and milliseconds zoomed in:
 * zooming in is how to place an edge just off another, and holding Alt places it freely.
 *
 * Targets sit on the edited timeline, where the pointer is, and carry the source time a range
 * takes when it latches there. At a join in the collapsed view the cut audio lies on neither
 * side, so a range's start latches to the cut's end (it begins after the join) and a range's end
 * to the cut's start (it stops before it); everywhere else both are the edge itself.
 *
 * While an edge is latched a guide line marks it, drawn in the renderer's scrolling content so
 * it moves with the waveform.
 */
import { type Span, TOUCH_EPSILON, firstEndingAfter, firstIndex } from "@/lib/edl";
import type WaveSurfer from "wavesurfer.js";
import { WAVE_HEIGHT } from "./layout";
import type { TimeMap } from "./timeMap";

/** How close (px on screen) a pointer or a dragged edge must come to an edge to latch on to it. */
export const SNAP_PX = 8;

/** Which end of a range is latching. */
export type SnapSide = "start" | "end";

/** An edge, in source time, and what it belongs to (a cut range's key, the selection), if any. */
export interface SnapEdge {
  source: number;
  owner?: string;
}

export interface SnapTarget {
  /** Where the edge sits on the edited timeline (seconds). */
  at: number;
  /** Source time a range's start takes when it latches here, and a range's end. */
  start: number;
  end: number;
  /** What the edge belongs to, so a drag of that range's own edges passes them over. */
  owner?: string;
}

/**
 * The targets for `edges`, projected through `timeMap` and sorted along the timeline. `cutSpans`
 * (every merged cut range) say which edges fall on a join in the collapsed view.
 */
export function snapTargets(edges: SnapEdge[], cutSpans: Span[], timeMap: TimeMap): SnapTarget[] {
  return edges
    .map(({ source, owner }): SnapTarget => {
      const at = timeMap.toEdited(source);
      if (timeMap.identity) return { at, start: source, end: source, owner };
      const span = cutSpans[firstEndingAfter(cutSpans, source - TOUCH_EPSILON)];
      const join = !!span && span[0] <= source + TOUCH_EPSILON;
      return { at, start: join ? span[1] : source, end: join ? span[0] : source, owner };
    })
    .sort((a, b) => a.at - b.at);
}

/**
 * The target nearest edited time `at` within `reach` seconds, or null. Targets owned by
 * `exclude` are passed over.
 */
export function nearestTarget(
  targets: SnapTarget[],
  at: number,
  reach: number,
  exclude?: string,
): SnapTarget | null {
  const usable = (t: SnapTarget) => exclude === undefined || t.owner !== exclude;
  let best: SnapTarget | null = null;
  let bestDistance = reach;
  const from = firstIndex(targets.length, (i) => targets[i].at >= at);
  for (let i = from; i < targets.length && targets[i].at - at <= bestDistance; i++) {
    if (!usable(targets[i])) continue;
    best = targets[i];
    bestDistance = targets[i].at - at;
    break;
  }
  for (let i = from - 1; i >= 0 && at - targets[i].at <= bestDistance; i--) {
    if (!usable(targets[i])) continue;
    if (at - targets[i].at < bestDistance || !best) best = targets[i];
    break;
  }
  return best;
}

/** The edited time under client x `clientX` on `ws`'s waveform, clamped to the timeline. */
export function editedTimeAt(ws: WaveSurfer, clientX: number): number {
  const rect = ws.getWrapper().getBoundingClientRect();
  const fraction = (clientX - rect.left) / Math.max(1, rect.width);
  return Math.min(1, Math.max(0, fraction)) * ws.getDuration();
}

export interface SnapGuides {
  /** Show a guide at each edited time in `ats` (none hides them). */
  show(ats: number[]): void;
  remove(): void;
}

/** Mount the guide lines into `ws`'s scrolling content, above the regions. */
export function mountSnapGuides(ws: WaveSurfer): SnapGuides {
  const wrapper = ws.getWrapper();
  const lines: HTMLDivElement[] = [];
  const line = (i: number) => {
    if (!lines[i]) {
      const el = document.createElement("div");
      Object.assign(el.style, {
        position: "absolute",
        top: "0",
        width: "2px",
        height: `${WAVE_HEIGHT}px`,
        marginLeft: "-1px",
        background: "var(--snap-guide)",
        boxShadow: "0 0 0 1px var(--color-surface)",
        zIndex: "6",
        pointerEvents: "none",
        display: "none",
      });
      wrapper.appendChild(el);
      lines[i] = el;
    }
    return lines[i];
  };
  return {
    show: (ats) => {
      const duration = Math.max(ws.getDuration(), Number.EPSILON);
      ats.forEach((at, i) => {
        const el = line(i);
        el.style.left = `${(at / duration) * 100}%`;
        el.style.display = "block";
      });
      for (let i = ats.length; i < lines.length; i++) lines[i].style.display = "none";
    },
    remove: () => {
      for (const el of lines) el.remove();
      lines.length = 0;
    },
  };
}
