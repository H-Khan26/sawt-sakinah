/**
 * Projects the silence list, the cut ranges, and the pending in/out selection onto the
 * waveform's Regions plugin, and wires region clicks back to selection + seek. The regions are
 * a view of app state, so this hook only reconciles — it holds no state of its own. It is the
 * single owner of the Regions plugin (it clears + rebuilds), so no other hook may draw onto it.
 *
 * It also owns drag-to-select: dragging on empty waveform paints a new selection, and dragging
 * the selection region's body/edges fine-tunes it. Region coordinates are edited-time, so they
 * invert through the `TimeMap` back to the source-time selection the store holds.
 */
import { activeSilences } from "@/features/silence/active";
import { removedSilenceKeys } from "@/features/silence/edl";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { useThemeColors } from "@/lib/themeColors";
import { useEditStore } from "@/stores/editStore";
import type { EditOperation, SilenceSegment } from "@/types/api";
import { useEffect, useMemo, useRef } from "react";
import { manualCutSpans, mergeCutSpans } from "./cutEdl";
import { SELECTION_REGION_ID, reconcileEditRegions } from "./regions";

export function useEditRegions(silences: SilenceSegment[], ops: EditOperation[]): void {
  const { regions, controller, timeMap, isReady } = useWaveformContext();
  const selectedIds = useEditStore((s) => s.selectedIds);
  const selectionStart = useEditStore((s) => s.selectionStart);
  const selectionEnd = useEditStore((s) => s.selectionEnd);
  const colors = useThemeColors();

  // Draw only the silence that survives content cuts; a cut range that is exactly a removed
  // silence is drawn as that silence, not again as a cut.
  const active = useMemo(() => activeSilences(silences, ops), [silences, ops]);
  const cutSpans = useMemo(() => mergeCutSpans(ops), [ops]);
  const removedIds = useMemo(() => removedSilenceKeys(active, cutSpans), [active, cutSpans]);
  const cuts = useMemo(() => manualCutSpans(cutSpans, active), [cutSpans, active]);

  // Reconcile overlays whenever the inputs, the selection, the mapping or the theme's colours
  // change (once laid out).
  useEffect(() => {
    if (!regions || !isReady) return;
    reconcileEditRegions(regions, {
      silences: active,
      removedIds,
      cutSpans: cuts,
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
    active,
    removedIds,
    cuts,
    selectedIds,
    selectionStart,
    selectionEnd,
    timeMap,
    colors,
  ]);

  // Click a region -> select it (silence/cut) and seek there. Region coordinates are edited-time,
  // so invert through the map to seek in source time. Read store actions via getState to avoid
  // stale closures.
  useEffect(() => {
    if (!regions) return;
    return regions.on("region-clicked", (region, e) => {
      e.stopPropagation();
      controller.setSourceTime(timeMap.toSource(region.start));
      // The selection is an editable overlay — clicking it only seeks (drag moves/resizes it).
      if (region.id === SELECTION_REGION_ID) return;
      useEditStore.getState().toggleSelected(region.id);
    });
  }, [regions, controller, timeMap]);

  // Enable drag-to-select once per plugin instance (and again for a new theme's colour). Kept
  // separate from the reconcile/handler effects so an in-progress drag is never torn down by a
  // state change mid-gesture.
  const selectionFill = colors.selectionColors.fill;
  useEffect(() => {
    if (!regions || !isReady) return;
    return regions.enableDragSelection({ color: selectionFill });
  }, [regions, isReady, selectionFill]);

  // Bridge Regions-plugin gestures back to the source-time selection store. `timeMap` is read
  // through a ref so these subscribe once (a fresh map mid-drag must not resubscribe). Both
  // `region-created` (a fresh drag) and `region-updated` (moving/resizing the selection) fire
  // only for user gestures we care about; programmatic `addRegion` never emits `region-updated`,
  // and drag-created regions carry an auto id (`region-…`) distinct from our known keys.
  const timeMapRef = useRef(timeMap);
  timeMapRef.current = timeMap;
  useEffect(() => {
    if (!regions) return;
    const offCreated = regions.on("region-created", (region) => {
      // Only a fresh drag-selection (auto id); ignore our own programmatic silence/cut/selection.
      if (!region.id.startsWith("region-")) return;
      const map = timeMapRef.current;
      const a = map.toSource(region.start);
      const b = map.toSource(region.end);
      region.remove(); // reconcile redraws the canonical, editable `selection` region
      useEditStore.getState().setSelectionRange(Math.min(a, b), Math.max(a, b));
    });
    const offUpdated = regions.on("region-updated", (region) => {
      if (region.id !== SELECTION_REGION_ID) return;
      const map = timeMapRef.current;
      const a = map.toSource(region.start);
      const b = map.toSource(region.end);
      useEditStore.getState().setSelectionRange(Math.min(a, b), Math.max(a, b));
    });
    return () => {
      offCreated();
      offUpdated();
    };
  }, [regions]);
}
