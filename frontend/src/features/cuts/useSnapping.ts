/**
 * What clicks and drags on the waveform latch on to (see `features/waveform/snap.ts`): the edges
 * the user can see. Those are the start and end of each surah passage the surah view shows, the
 * edges of each cut range (their joins in the collapsed view), the edges of the pending
 * selection, and the timeline's two ends.
 *
 * Snapping is on unless the user turned it off (the `snapEdges` preference), and is bypassed
 * while Alt is held. Hovering near an edge shows its guide where the caller's `seeks` says a
 * click there would seek, and so latch on to it. `useEditRegions` drives the guides itself
 * during a drag.
 */
import { visiblePassages } from "@/features/surahs/surahModel";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { WAVE_HEIGHT } from "@/features/waveform/layout";
import {
  SNAP_PX,
  type SnapEdge,
  type SnapGuides,
  type SnapSide,
  type SnapTarget,
  editedTimeAt,
  mountSnapGuides,
  nearestTarget,
  snapTargets,
} from "@/features/waveform/snap";
import { useEditStore } from "@/stores/editStore";
import { useViewPrefs } from "@/stores/viewPrefs";
import type { ProjectView, SurahPassage } from "@/types/api";
import { useEffect, useMemo, useRef } from "react";
import { cutKey } from "./cutEdl";
import { SELECTION_REGION_ID } from "./regions";

const NO_PASSAGES: SurahPassage[] = [];

/** Where an edge latched: on the edited timeline, and the source time it takes there. */
export interface Latch {
  at: number;
  source: number;
}

export interface Snapper {
  /**
   * Latch edited time `at`, as a range's `side`, on to the nearest edge in reach, passing over
   * the edges of `exclude` (a cut range's key, or the selection's region id). Null when none is
   * in reach, snapping is off or Alt is held.
   */
  latch(at: number, side: SnapSide, exclude?: string): Latch | null;
  /** Show a guide at each edited time in `ats`; none hides them. */
  guide(ats: number[]): void;
}

/**
 * The snapper for `project`'s waveform. `seeks` tells whether a click at edited time `at` seeks
 * (`onBars`: on the bars, not the ruler beneath; `target`: the element under the pointer).
 */
export function useSnapping(
  project: ProjectView,
  seeks: (at: number, onBars: boolean, target: Element | null) => boolean,
): Snapper {
  const { wavesurfer, timeMap, cutSpans } = useWaveformContext();
  const enabled = useViewPrefs((s) => s.snapEdges);
  const surahView = useViewPrefs((s) => s.surahView);
  const showFatihah = useViewPrefs((s) => s.showFatihah);
  const selectionStart = useEditStore((s) => s.selectionStart);
  const selectionEnd = useEditStore((s) => s.selectionEnd);
  const passages = project.surahs?.passages ?? NO_PASSAGES;

  const targets = useMemo(() => {
    const edges: SnapEdge[] = [];
    for (const span of cutSpans) {
      const owner = cutKey(span);
      edges.push({ source: span[0], owner });
      // Collapsed, both edges are the one join.
      if (timeMap.identity) edges.push({ source: span[1], owner });
    }
    if (surahView) {
      for (const p of visiblePassages(passages, showFatihah)) {
        edges.push({ source: p.start }, { source: p.end });
      }
    }
    if (selectionStart != null && selectionEnd != null) {
      edges.push(
        { source: selectionStart, owner: SELECTION_REGION_ID },
        { source: selectionEnd, owner: SELECTION_REGION_ID },
      );
    }
    const end = (at: number): SnapTarget => {
      const source = timeMap.toSource(at);
      return { at, start: source, end: source };
    };
    // Every edge lies on the timeline, so its two ends bracket the sorted edges.
    return [end(0), ...snapTargets(edges, cutSpans, timeMap), end(timeMap.editedTotal)];
  }, [cutSpans, passages, surahView, showFatihah, selectionStart, selectionEnd, timeMap]);

  const latest = useRef({ targets, enabled, wavesurfer, seeks });
  latest.current = { targets, enabled, wavesurfer, seeks };
  /** Whether Alt was down at the last pointer or key event. */
  const altRef = useRef(false);
  const guidesRef = useRef<SnapGuides | null>(null);

  const snapper = useMemo<Snapper>(
    () => ({
      latch: (at, side, exclude) => {
        const { targets, enabled, wavesurfer: ws } = latest.current;
        if (!enabled || altRef.current || !ws) return null;
        const reach = (SNAP_PX * ws.getDuration()) / Math.max(1, ws.getWrapper().scrollWidth);
        const target = nearestTarget(targets, at, reach, exclude);
        if (!target) return null;
        return { at: target.at, source: side === "start" ? target.start : target.end };
      },
      guide: (ats) => guidesRef.current?.show(ats),
    }),
    [],
  );

  // The guides, and the hover preview: near an edge, its guide shows where a click would land.
  useEffect(() => {
    if (!wavesurfer) return;
    const wrapper = wavesurfer.getWrapper();
    const guides = mountSnapGuides(wavesurfer);
    guidesRef.current = guides;
    /** The pointer while it hovers the waveform with no button down; null otherwise. */
    let hover: { x: number; y: number } | null = null;
    // The renderer draws in a shadow root; looking the element up there finds its regions.
    const root = wrapper.getRootNode() as Document | ShadowRoot;

    // A scroll or zoom moves the waveform under a still pointer, so the element under it is
    // looked up afresh each time.
    const preview = () => {
      if (!hover) return;
      const at = editedTimeAt(wavesurfer, hover.x);
      const onBars = hover.y - wrapper.getBoundingClientRect().top <= WAVE_HEIGHT;
      const target = root.elementFromPoint(hover.x, hover.y);
      const hit = latest.current.seeks(at, onBars, target) ? snapper.latch(at, "start") : null;
      guides.show(hit ? [hit.at] : []);
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons !== 0) return; // a drag drives the guides itself
      hover = { x: e.clientX, y: e.clientY };
      preview();
    };
    const onDown = () => {
      hover = null;
    };
    const onLeave = (e: PointerEvent) => {
      hover = null;
      if (e.buttons === 0) guides.show([]);
    };
    const noteAlt = (e: PointerEvent | KeyboardEvent) => {
      if (altRef.current === e.altKey) return;
      altRef.current = e.altKey;
      if (e instanceof KeyboardEvent) preview();
    };
    const clearAlt = () => {
      altRef.current = false;
    };

    wrapper.addEventListener("pointermove", onMove);
    wrapper.addEventListener("pointerdown", onDown);
    wrapper.addEventListener("pointerleave", onLeave);
    document.addEventListener("pointerdown", noteAlt, true);
    document.addEventListener("pointermove", noteAlt, true);
    document.addEventListener("keydown", noteAlt, true);
    document.addEventListener("keyup", noteAlt, true);
    window.addEventListener("blur", clearAlt);
    const offs = [wavesurfer.on("scroll", preview), wavesurfer.on("zoom", preview)];
    return () => {
      for (const off of offs) off();
      wrapper.removeEventListener("pointermove", onMove);
      wrapper.removeEventListener("pointerdown", onDown);
      wrapper.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("pointerdown", noteAlt, true);
      document.removeEventListener("pointermove", noteAlt, true);
      document.removeEventListener("keydown", noteAlt, true);
      document.removeEventListener("keyup", noteAlt, true);
      window.removeEventListener("blur", clearAlt);
      guides.remove();
      guidesRef.current = null;
    };
  }, [wavesurfer, snapper]);

  // Turning snapping off, or a change to the edges, leaves no stale guide behind.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the targets and the setting are the triggers
  useEffect(() => {
    guidesRef.current?.show([]);
  }, [targets, enabled]);

  return snapper;
}
