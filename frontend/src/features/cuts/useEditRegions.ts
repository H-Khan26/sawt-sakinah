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
 * and the playhead moves to its start, and empty waveform deselects the cut range.
 *
 * It also owns the drags: dragging on the waveform paints a new selection, dragging the selection
 * region's body/edges fine-tunes it, and dragging a selected cut range's edge commits one edit
 * on release (`useCutCommands().resizeCut`). Region coordinates are edited-time, so they invert
 * through the `TimeMap` back to the source time the store and the EDL hold.
 */
import { silenceKey } from "@/features/silence/regions";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { WAVE_HEIGHT } from "@/features/waveform/layout";
import { useThemeColors } from "@/lib/themeColors";
import { useEditStore } from "@/stores/editStore";
import type { ProjectView } from "@/types/api";
import { useEffect, useRef } from "react";
import { CUT_KEY_PREFIX, cutKey } from "./cutEdl";
import { useCutModel } from "./cutModel";
import { SELECTION_REGION_ID, reconcileEditRegions } from "./regions";
import { useCutCommands } from "./useCutCommands";

export function useEditRegions(project: ProjectView): void {
  const { wavesurfer, regions, controller, timeMap, isReady } = useWaveformContext();
  const selectedIds = useEditStore((s) => s.selectedIds);
  const selectionStart = useEditStore((s) => s.selectionStart);
  const selectionEnd = useEditStore((s) => s.selectionEnd);
  const colors = useThemeColors();
  const commands = useCutCommands(project.id);

  // Draw only the silence that survives content cuts and isn't removed; removed audio is drawn
  // from the merged cut ranges alone, so no range is drawn twice.
  const { cutSpans, kept } = useCutModel(project);

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

  // Handlers read the latest state through refs so they subscribe once per instance; a fresh map
  // or edit mid-gesture must not tear a drag down.
  const latest = useRef({ timeMap, cutSpans, kept, commands });
  latest.current = { timeMap, cutSpans, kept, commands };

  // A click on the waveform (wavesurfer has already seeked to it): select what lies under it. The
  // regions span the bars only, so a click on the time ruler beneath just seeks.
  useEffect(() => {
    if (!wavesurfer) return;
    return wavesurfer.on("click", (relativeX, relativeY) => {
      const { timeMap: map, cutSpans: spans, kept: segs } = latest.current;
      const t = map.toSource(relativeX * wavesurfer.getDuration());
      const onBars = relativeY * wavesurfer.getWrapper().clientHeight <= WAVE_HEIGHT;
      const store = useEditStore.getState();
      const cut = onBars && map.identity ? spans.find(([a, b]) => a <= t && t <= b) : undefined;
      store.selectCut(cut ? cutKey(cut) : null);
      if (cut) {
        controller.setSourceTime(cut[0]);
        return;
      }
      const seg = onBars ? segs.find((s) => s.start <= t && t <= s.end) : undefined;
      if (seg) {
        store.toggleSelected(silenceKey(seg));
        controller.setSourceTime(seg.start);
      }
    });
  }, [wavesurfer, controller]);

  // A click on the selection region seeks to its start (a drag moves or resizes it instead). The
  // only other regions that take clicks are a selected cut's grips: a click there leaves the
  // range selected and the playhead where it is.
  useEffect(() => {
    if (!regions) return;
    return regions.on("region-clicked", (region, e) => {
      e.stopPropagation();
      if (region.id !== SELECTION_REGION_ID) return;
      controller.setSourceTime(latest.current.timeMap.toSource(region.start));
    });
  }, [regions, controller]);

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
  // calls, which are ignored; `region-updated` fires only when a user drag or resize ends.
  useEffect(() => {
    if (!regions) return;
    const offCreated = regions.on("region-created", (region) => {
      if (!region.id.startsWith("region-")) return;
      const map = latest.current.timeMap;
      const a = map.toSource(region.start);
      const b = map.toSource(region.end);
      region.remove(); // reconcile redraws the canonical, editable `selection` region
      const store = useEditStore.getState();
      store.setSelectionRange(Math.min(a, b), Math.max(a, b));
      store.selectCut(null);
    });
    const offUpdated = regions.on("region-updated", (region, side) => {
      const map = latest.current.timeMap;
      const a = map.toSource(region.start);
      const b = map.toSource(region.end);
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
      offCreated();
      offUpdated();
    };
  }, [regions]);
}
