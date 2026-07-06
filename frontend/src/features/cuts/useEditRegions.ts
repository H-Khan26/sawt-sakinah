/**
 * Projects the silence list, committed manual cuts, and the pending in/out selection onto the
 * waveform's Regions plugin, and wires region clicks back to selection + seek. The regions are
 * a view of app state, so this hook only reconciles — it holds no state of its own. It is the
 * single owner of the Regions plugin (it clears + rebuilds), so no other hook may draw onto it.
 */
import { activeSilences } from "@/features/silence/active";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { useEditStore } from "@/stores/editStore";
import type { EditOperation, SilenceSegment } from "@/types/api";
import { useEffect, useMemo } from "react";
import { manualCuts } from "./cutEdl";
import { SELECTION_REGION_ID, reconcileEditRegions } from "./regions";

export function useEditRegions(silences: SilenceSegment[], ops: EditOperation[]): void {
  const { regions, controller, timeMap, isReady } = useWaveformContext();
  const selectedIds = useEditStore((s) => s.selectedIds);
  const selectionStart = useEditStore((s) => s.selectionStart);
  const selectionEnd = useEditStore((s) => s.selectionEnd);

  // Draw only the silence that survives manual cuts; classify manual cuts against that same
  // active set so a removed clipped-silence isn't also drawn as a manual-cut region.
  const active = useMemo(() => activeSilences(silences, ops), [silences, ops]);
  const cuts = useMemo(() => manualCuts(ops, active), [ops, active]);

  // Reconcile overlays whenever the inputs, the selection, or the mapping change (once laid out).
  useEffect(() => {
    if (!regions || !isReady) return;
    reconcileEditRegions(regions, {
      silences: active,
      manualCuts: cuts,
      selectedIds,
      selectionStart,
      selectionEnd,
      timeMap,
    });
    return () => regions.clearRegions();
  }, [regions, isReady, active, cuts, selectedIds, selectionStart, selectionEnd, timeMap]);

  // Click a region -> select it (silence/cut) and seek there. Region coordinates are edited-time,
  // so invert through the map to seek in source time. Read store actions via getState to avoid
  // stale closures.
  useEffect(() => {
    if (!regions) return;
    return regions.on("region-clicked", (region, e) => {
      e.stopPropagation();
      controller.setSourceTime(timeMap.toSource(region.start));
      // The pending selection is a passive overlay — clicking it only seeks.
      if (region.id === SELECTION_REGION_ID) return;
      useEditStore.getState().toggleSelected(region.id);
    });
  }, [regions, controller, timeMap]);
}
