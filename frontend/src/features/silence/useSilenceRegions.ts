/**
 * Projects the silence list + selection onto the waveform's Regions plugin, and wires
 * region clicks back to selection + seek. The regions are a view of app state, so this
 * hook only reconciles — it holds no state of its own.
 */
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { useEditStore } from "@/stores/editStore";
import type { SilenceSegment } from "@/types/api";
import { useEffect } from "react";
import { reconcileRegions } from "./regions";

export function useSilenceRegions(silences: SilenceSegment[]): void {
  const { regions, wavesurfer, isReady } = useWaveformContext();
  const selectedIds = useEditStore((s) => s.selectedIds);

  // Reconcile overlays whenever the silences or the selection change (once laid out).
  useEffect(() => {
    if (!regions || !isReady) return;
    reconcileRegions(regions, silences, selectedIds);
    return () => regions.clearRegions();
  }, [regions, isReady, silences, selectedIds]);

  // Click a region -> toggle its selection and seek there. Plugin-level, so it survives
  // the region rebuilds above; read store actions via getState to avoid stale closures.
  useEffect(() => {
    if (!regions) return;
    return regions.on("region-clicked", (region, e) => {
      e.stopPropagation();
      useEditStore.getState().toggleSelected(region.id);
      wavesurfer?.setTime(region.start);
    });
  }, [regions, wavesurfer]);
}
