/**
 * Projects the silence list, committed manual cuts, and the pending in/out selection onto the
 * waveform's Regions plugin, and wires region clicks back to selection + seek. The regions are
 * a view of app state, so this hook only reconciles — it holds no state of its own. It is the
 * single owner of the Regions plugin (it clears + rebuilds), so no other hook may draw onto it.
 */
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { useEditStore } from "@/stores/editStore";
import type { EditOperation, SilenceSegment } from "@/types/api";
import { useEffect, useMemo } from "react";
import { manualCuts } from "./cutEdl";
import { SELECTION_REGION_ID, reconcileEditRegions } from "./regions";

export function useEditRegions(silences: SilenceSegment[], ops: EditOperation[]): void {
  const { regions, wavesurfer, isReady } = useWaveformContext();
  const selectedIds = useEditStore((s) => s.selectedIds);
  const selectionStart = useEditStore((s) => s.selectionStart);
  const selectionEnd = useEditStore((s) => s.selectionEnd);

  const cuts = useMemo(() => manualCuts(ops, silences), [ops, silences]);

  // Reconcile overlays whenever the inputs or the selection change (once laid out).
  useEffect(() => {
    if (!regions || !isReady) return;
    reconcileEditRegions(regions, {
      silences,
      manualCuts: cuts,
      selectedIds,
      selectionStart,
      selectionEnd,
    });
    return () => regions.clearRegions();
  }, [regions, isReady, silences, cuts, selectedIds, selectionStart, selectionEnd]);

  // Click a region -> select it (silence/cut) and seek there. Plugin-level so it survives the
  // region rebuilds above; read store actions via getState to avoid stale closures.
  useEffect(() => {
    if (!regions) return;
    return regions.on("region-clicked", (region, e) => {
      e.stopPropagation();
      wavesurfer?.setTime(region.start);
      // The pending selection is a passive overlay — clicking it only seeks.
      if (region.id === SELECTION_REGION_ID) return;
      useEditStore.getState().toggleSelected(region.id);
    });
  }, [regions, wavesurfer]);
}
