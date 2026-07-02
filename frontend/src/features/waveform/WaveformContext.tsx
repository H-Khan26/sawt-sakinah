/**
 * Shares the live wavesurfer instance (and its container ref + load state) with the
 * transport and, in later phases, the silence-region and marker layers — so features reach
 * the instance without prop-drilling. Only *low-frequency* facts live here (the instance,
 * whether it's ready, load errors); the per-frame playhead stays in `playbackStore` so
 * consuming this context does not couple a component to frame-rate re-renders.
 */
import { useWaveform } from "@/api/hooks";
import { type ReactNode, type RefObject, createContext, useContext, useMemo, useRef } from "react";
import type WaveSurfer from "wavesurfer.js";
import type RegionsPlugin from "wavesurfer.js/plugins/regions";
import { useWavesurfer } from "./useWavesurfer";

interface WaveformContextValue {
  /** Attach to the element wavesurfer renders into (see `WaveformView`). */
  containerRef: RefObject<HTMLDivElement>;
  /** The live instance, or null before creation / after teardown. */
  wavesurfer: WaveSurfer | null;
  /** Regions plugin for silence/marker overlays; null before creation / after teardown. */
  regions: RegionsPlugin | null;
  /** True once audio is decoded and playable. */
  isReady: boolean;
  /** Peaks are still being fetched. */
  isLoadingPeaks: boolean;
  /** A peaks-fetch or wavesurfer load error, if any. */
  error: Error | null;
}

const WaveformContext = createContext<WaveformContextValue | null>(null);

export function WaveformProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const peaksQuery = useWaveform(projectId);
  const { wavesurfer, regions, isReady, error } = useWavesurfer({
    container: containerRef,
    projectId,
    peaks: peaksQuery.data,
  });

  const value = useMemo<WaveformContextValue>(
    () => ({
      containerRef,
      wavesurfer,
      regions,
      isReady,
      isLoadingPeaks: peaksQuery.isPending,
      error: error ?? (peaksQuery.error as Error | null),
    }),
    [wavesurfer, regions, isReady, peaksQuery.isPending, peaksQuery.error, error],
  );

  return <WaveformContext.Provider value={value}>{children}</WaveformContext.Provider>;
}

/** Read the waveform context. Throws if used outside `WaveformProvider`. */
export function useWaveformContext(): WaveformContextValue {
  const ctx = useContext(WaveformContext);
  if (!ctx) throw new Error("useWaveformContext must be used within a WaveformProvider");
  return ctx;
}
