/**
 * Projects the kept silences, the cut ranges, and the pending in/out selection onto the
 * waveform's Regions plugin, and wires waveform clicks and drags back to selection, seeking and
 * edits. The regions are a view of app state, so this hook only reconciles — it holds no state
 * of its own. It is the single owner of the Regions plugin (it clears + rebuilds), so no other
 * hook may draw onto it.
 *
 * Silence and cut regions let the pointer through (see `regions.ts`), so a click on them reaches
 * the waveform, which seeks; the click is then mapped back to what lies under it: a cut range
 * (full view) is selected and the playhead moves to its start, a silence toggles its selection
 * and the playhead moves to its start, and empty waveform deselects the cut range. Silences are
 * left out entirely while `SILENCE_TOOL` is off.
 *
 * It also owns the drags: dragging on the waveform paints a new selection, dragging the selection
 * region's body/edges fine-tunes it, and dragging a selected cut range's edge commits one edit
 * on release (`useCutCommands().resizeCut`). Region coordinates are edited-time, so they invert
 * through the `TimeMap` back to the source time the store and the EDL hold.
 *
 * Clicks and drags latch on to nearby edges (`useSnapping`). A click on nothing to select, or on
 * the selection, seeks to the edge it latched on to. A drag latches as it goes: the plugin moves a region by adding
 * the pointer's travel to its bounds, so those bounds stay where the pointer put them (or an
 * edge, once latched, could never be pulled off again), the region is drawn at its latched
 * bounds with a guide on each latched edge, and the release commits what was drawn.
 */
import { SILENCE_TOOL } from "@/features/silence/enabled";
import { silenceKey } from "@/features/silence/regions";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { WAVE_HEIGHT } from "@/features/waveform/layout";
import { editedTimeAt } from "@/features/waveform/snap";
import type { TimeMap } from "@/features/waveform/timeMap";
import type { Span } from "@/lib/edl";
import { useThemeColors } from "@/lib/themeColors";
import { useEditStore } from "@/stores/editStore";
import type { ProjectView, SilenceSegment } from "@/types/api";
import { useEffect, useRef } from "react";
import type WaveSurfer from "wavesurfer.js";
import type { Region } from "wavesurfer.js/plugins/regions";
import { CUT_KEY_PREFIX, cutKey } from "./cutEdl";
import { useCutModel } from "./cutModel";
import { SELECTION_REGION_ID, reconcileEditRegions } from "./regions";
import { useCutCommands } from "./useCutCommands";
import { type Latch, type Snapper, useSnapping } from "./useSnapping";

const NO_SILENCES: SilenceSegment[] = [];

/**
 * How a region drag moves its bounds: one edge, the whole region, or both edges of a fresh
 * selection being painted (the press point and the pointer).
 */
type DragMode = "start" | "end" | "move" | "paint";

/** A dragged region's latched bounds: as drawn on the edited timeline, and in source time. */
interface Latched {
  shown: Span;
  source: Span;
  /** Edited times of the edges that latched. */
  guides: number[];
}

/**
 * Latch the bounds of a region under drag (`mode`) on to nearby edges, passing over those owned
 * by `exclude`. A dragged edge latches alone; a moved region shifts so whichever of its edges
 * is nearer an edge lands on it; a painted selection latches each edge, only the nearer one
 * when both latching would turn the range inside out or empty it. An edge the drag leaves in
 * place keeps its source time in `held` (the region's committed bounds), since at a join in the
 * collapsed view its position alone can't say which side of the cut it is on.
 */
function latchRegion(
  region: Region,
  mode: DragMode,
  snapper: Snapper,
  map: TimeMap,
  exclude: string,
  held: Span | null,
): Latched {
  const [a, b] = [region.start, region.end];
  const raw: Latched = {
    shown: [a, b],
    source: [
      mode === "end" && held ? held[0] : map.toSource(a),
      mode === "start" && held ? held[1] : map.toSource(b),
    ],
    guides: [],
  };
  const hitA = mode === "end" ? null : snapper.latch(a, "start", exclude);
  const hitB = mode === "start" ? null : snapper.latch(b, "end", exclude);
  const nearerA = (ha: Latch, hb: Latch) => Math.abs(ha.at - a) <= Math.abs(hb.at - b);
  const valid = (latched: Latched) => latched.shown[1] > latched.shown[0];

  if (mode === "move") {
    const hit = hitA && (!hitB || nearerA(hitA, hitB)) ? hitA : hitB;
    if (!hit) return raw;
    const onA = hit === hitA;
    const shift = hit.at - (onA ? a : b);
    const shown: Span = [a + shift, b + shift];
    const latched: Latched = {
      shown,
      source: onA ? [hit.source, map.toSource(shown[1])] : [map.toSource(shown[0]), hit.source],
      guides: [hit.at],
    };
    return valid(latched) ? latched : raw;
  }

  const latch = (ha: Latch | null, hb: Latch | null): Latched => ({
    shown: [ha?.at ?? a, hb?.at ?? b],
    source: [ha?.source ?? raw.source[0], hb?.source ?? raw.source[1]],
    guides: [ha, hb].flatMap((hit) => (hit ? [hit.at] : [])),
  });
  const latched = latch(hitA, hitB);
  if (valid(latched)) return latched;
  if (hitA && hitB) {
    const nearer = nearerA(hitA, hitB) ? latch(hitA, null) : latch(null, hitB);
    if (valid(nearer)) return nearer;
  }
  return raw;
}

/** Draw `region` at edited bounds `[start, end]`, leaving the bounds the plugin keeps as they are. */
function drawAt(region: Region, ws: WaveSurfer, [start, end]: Span): void {
  const el = region.element;
  if (!el) return;
  const duration = Math.max(ws.getDuration(), Number.EPSILON);
  el.style.left = `${(start / duration) * 100}%`;
  el.style.right = `${((duration - end) / duration) * 100}%`;
}

/** How a saved region's update moved it: by one edge (`side`), or whole. */
const modeOf = (side: "start" | "end" | undefined): DragMode => side ?? "move";

interface ClickState {
  timeMap: TimeMap;
  cutSpans: Span[];
  kept: SilenceSegment[];
}

/**
 * What a click at source time `t` selects (`onBars`: on the bars, not the ruler beneath): the
 * cut range under it in the full view, else the silence under it, else nothing.
 */
function clickTarget(
  { timeMap: map, cutSpans, kept }: ClickState,
  t: number,
  onBars: boolean,
): { cut?: Span; seg?: SilenceSegment } {
  if (!onBars) return {};
  const cut = map.identity ? cutSpans.find(([a, b]) => a <= t && t <= b) : undefined;
  if (cut) return { cut };
  return { seg: kept.find((s) => s.start <= t && t <= s.end) };
}

export function useEditRegions(project: ProjectView): void {
  const { wavesurfer, regions, controller, timeMap, isReady } = useWaveformContext();
  const selectedIds = useEditStore((s) => s.selectedIds);
  const selectionStart = useEditStore((s) => s.selectionStart);
  const selectionEnd = useEditStore((s) => s.selectionEnd);
  const colors = useThemeColors();
  const commands = useCutCommands(project.id);

  // Draw only the silence that survives content cuts and isn't removed; removed audio is drawn
  // from the merged cut ranges alone, so no range is drawn twice. None while the tool is off.
  const model = useCutModel(project);
  const { cutSpans } = model;
  const kept = SILENCE_TOOL ? model.kept : NO_SILENCES;

  // Handlers read the latest state through refs so they subscribe once per instance; a fresh map
  // or edit mid-gesture must not tear a drag down.
  const latest = useRef({ timeMap, cutSpans, kept, commands });
  latest.current = { timeMap, cutSpans, kept, commands };

  // Whether a click there seeks, by the rules of the handlers below. The only regions that take
  // the pointer are the selection, whose click seeks, and a selected cut's grips, whose click
  // doesn't.
  const snapper = useSnapping(project, (at, onBars, target) => {
    const region = target?.closest('[part~="region"]');
    if (region) return region.matches(`[part~="${SELECTION_REGION_ID}"]`);
    const { cut, seg } = clickTarget(latest.current, latest.current.timeMap.toSource(at), onBars);
    return !cut && !seg;
  });

  // Reconcile overlays whenever the inputs, the selection, the mapping or the theme's colours
  // change (once laid out).
  useEffect(() => {
    if (!regions || !isReady) return;
    reconcileEditRegions(regions, {
      silences: kept,
      cutSpans,
      selectedIds,
      selectionStart,
      selectionEnd,
      timeMap,
      colors,
    });
    return () => regions.clearRegions();
  }, [
    regions,
    isReady,
    kept,
    cutSpans,
    selectedIds,
    selectionStart,
    selectionEnd,
    timeMap,
    colors,
  ]);

  // A click on the waveform (wavesurfer has already seeked to it): select what lies under it. The
  // regions span the bars only, so a click on the time ruler beneath just seeks. A click on
  // nothing to select seeks to the edge it latches on to, if any.
  useEffect(() => {
    if (!wavesurfer) return;
    return wavesurfer.on("click", (relativeX, relativeY) => {
      const t = latest.current.timeMap.toSource(relativeX * wavesurfer.getDuration());
      const onBars = relativeY * wavesurfer.getWrapper().clientHeight <= WAVE_HEIGHT;
      const { cut, seg } = clickTarget(latest.current, t, onBars);
      const store = useEditStore.getState();
      store.selectCut(cut ? cutKey(cut) : null);
      if (cut) {
        controller.setSourceTime(cut[0]);
        return;
      }
      if (seg) {
        store.toggleSelected(silenceKey(seg));
        controller.setSourceTime(seg.start);
        return;
      }
      const hit = snapper.latch(relativeX * wavesurfer.getDuration(), "start");
      if (hit) controller.setSourceTime(hit.source);
    });
  }, [wavesurfer, controller, snapper]);

  // A click on the selection region seeks to the edge it latches on to, its own included, or
  // else to the point clicked (a drag moves or resizes it instead). The only other regions that
  // take clicks are a selected cut's grips: a click there leaves the range selected and the
  // playhead where it is.
  useEffect(() => {
    if (!regions || !wavesurfer) return;
    return regions.on("region-clicked", (region, e) => {
      e.stopPropagation();
      if (region.id !== SELECTION_REGION_ID) return;
      const at = editedTimeAt(wavesurfer, e.clientX);
      const hit = snapper.latch(at, "start");
      controller.setSourceTime(hit ? hit.source : latest.current.timeMap.toSource(at));
    });
  }, [regions, wavesurfer, controller, snapper]);

  // Enable drag-to-select once per plugin instance (and again for a new theme's colour). Kept
  // separate from the reconcile/handler effects so an in-progress drag is never torn down by a
  // state change mid-gesture.
  const selectionFill = colors.selectionColors.fill;
  useEffect(() => {
    if (!regions || !isReady) return;
    return regions.enableDragSelection({ color: selectionFill });
  }, [regions, isReady, selectionFill]);

  // Bridge Regions-plugin gestures back to the store and the EDL. `region-created` fires for a
  // fresh drag (an auto id, `region-…`, distinct from our keys) and for our own `addRegion`
  // calls, which are ignored; `region-update` fires as a user drag or resize moves, and
  // `region-updated` when it ends. A move draws the latched bounds (`latchRegion`); the release
  // commits the bounds last drawn, so a key or zoom since the last move doesn't shift them.
  useEffect(() => {
    if (!regions || !wavesurfer) return;
    const isFresh = (region: Region) => region.id.startsWith("region-");
    // A dragged region's committed source bounds: the selection's, or its cut range's.
    const heldOf = (region: Region): Span | null => {
      if (region.id === SELECTION_REGION_ID) {
        const { selectionStart: s, selectionEnd: e } = useEditStore.getState();
        return s != null && e != null ? [Math.min(s, e), Math.max(s, e)] : null;
      }
      return latest.current.cutSpans.find((span) => cutKey(span) === region.id) ?? null;
    };
    // A dragged region passes over its own edges; a fresh one replaces the selection, so it
    // passes over the selection's.
    const latchOf = (region: Region, mode: DragMode) =>
      latchRegion(
        region,
        mode,
        snapper,
        latest.current.timeMap,
        isFresh(region) ? SELECTION_REGION_ID : region.id,
        isFresh(region) ? null : heldOf(region),
      );
    /** The region under drag and its bounds as last drawn. */
    let drawn: { region: Region; latched: Latched } | null = null;
    const draw = (region: Region, mode: DragMode) => {
      const latched = latchOf(region, mode);
      drawn = { region, latched };
      drawAt(region, wavesurfer, latched.shown);
      snapper.guide(latched.guides);
    };
    /** End the drag of `region`: its bounds as last drawn (or latched now, if never drawn). */
    const release = (region: Region, mode: DragMode): Latched => {
      const latched = drawn?.region === region ? drawn.latched : latchOf(region, mode);
      drawn = null;
      snapper.guide([]);
      return latched;
    };

    // A fresh selection is saved (and announced) only once its drag ends, so follow it from birth.
    const offInitialized = regions.on("region-initialized", (region) => {
      if (isFresh(region)) region.on("update", () => draw(region, "paint"));
    });
    const offUpdate = regions.on("region-update", (region, side) => {
      if (region.id === SELECTION_REGION_ID || region.id.startsWith(CUT_KEY_PREFIX)) {
        draw(region, modeOf(side));
      }
    });
    const offCreated = regions.on("region-created", (region) => {
      if (!isFresh(region)) return;
      const [a, b] = release(region, "paint").source;
      region.remove(); // reconcile redraws the canonical, editable `selection` region
      const store = useEditStore.getState();
      store.setSelectionRange(Math.min(a, b), Math.max(a, b));
      store.selectCut(null);
    });
    const offUpdated = regions.on("region-updated", (region, side) => {
      const map = latest.current.timeMap;
      const { shown, source } = release(region, modeOf(side));
      const [a, b] = source;
      // The plugin's bounds take the drawn ones, for when no redraw replaces the region.
      region.setOptions({ start: shown[0], end: shown[1] });
      if (region.id === SELECTION_REGION_ID) {
        useEditStore.getState().setSelectionRange(Math.min(a, b), Math.max(a, b));
      } else if (region.id.startsWith(CUT_KEY_PREFIX)) {
        // An edge drag of the selected cut range. When it commits nothing (a nudge shorter than
        // a cut) no redraw follows, so put the region back on its range.
        const time = side === "start" ? a : b;
        if (side && latest.current.commands.resizeCut(region.id, side, time)) return;
        const span = latest.current.cutSpans.find((s) => cutKey(s) === region.id);
        if (span) region.setOptions({ start: map.toEdited(span[0]), end: map.toEdited(span[1]) });
      }
    });
    return () => {
      offInitialized();
      offUpdate();
      offCreated();
      offUpdated();
    };
  }, [regions, wavesurfer, snapper]);
}
