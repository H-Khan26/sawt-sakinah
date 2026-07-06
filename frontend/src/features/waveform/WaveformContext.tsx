/**
 * Owns the waveform engine (renderer + playback) and shares it with the transport, the region
 * layer (silence + cuts + selection), and the marker layer, so features reach it without
 * prop-drilling. Only low-frequency facts live here (the instance, ready/error state, the
 * playback `controller`, and the current source<->edited `TimeMap`); the per-frame playhead
 * stays in `playbackStore` so consuming this context does not couple a component to frame-rate
 * re-renders.
 *
 * The provider is the single place that composes app state into what the engine renders: it
 * builds the `TimeMap` and the edited peaks from the EDL + the `showDeleted` view preference,
 * and hands them down. Cut spans (for live skip) and the mapping (for cursor + overlays) are
 * derived here so the engine stays a pure mechanism.
 */
import { useWaveform } from "@/api/hooks";
import { mergeCutSpans } from "@/features/cuts/cutEdl";
import { useViewPrefs } from "@/stores/viewPrefs";
import type { ProjectView } from "@/types/api";
import { type ReactNode, type RefObject, createContext, useContext, useMemo, useRef } from "react";
import type WaveSurfer from "wavesurfer.js";
import type RegionsPlugin from "wavesurfer.js/plugins/regions";
import { type RenderPeaks, sliceEditedPeaks, sourceRenderPeaks } from "./editedPeaks";
import { type TimeMap, buildTimeMap } from "./timeMap";
import { type WaveformController, useWaveformEngine } from "./useWaveformEngine";

interface WaveformContextValue {
  /** Attach to the element wavesurfer renders into (see `WaveformView`). */
  containerRef: RefObject<HTMLDivElement>;
  /** The live renderer instance, or null before creation / after teardown. */
  wavesurfer: WaveSurfer | null;
  /** Regions plugin for silence/cut/selection overlays; null before creation / after teardown. */
  regions: RegionsPlugin | null;
  /** Source-time playback surface (seek, play, read the playhead). */
  controller: WaveformController;
  /** Current source <-> edited mapping (identity when deleted portions are shown). */
  timeMap: TimeMap;
  /** True once the waveform is rendered. */
  isReady: boolean;
  /** Peaks are still being fetched. */
  isLoadingPeaks: boolean;
  /** A peaks-fetch, audio, or render error, if any. */
  error: Error | null;
}

const WaveformContext = createContext<WaveformContextValue | null>(null);

export function WaveformProvider({
  project,
  children,
}: {
  project: ProjectView;
  children: ReactNode;
}) {
  const projectId = project.id;
  const ops = project.edl.operations;

  const containerRef = useRef<HTMLDivElement>(null);
  const peaksQuery = useWaveform(projectId);
  const sourcePeaks = peaksQuery.data;

  const showDeleted = useViewPrefs((s) => s.showDeleted);
  const collapsed = !showDeleted;
  const sourceDuration = sourcePeaks?.duration_sec ?? project.audio_source.duration_sec;

  const timeMap = useMemo(
    () => buildTimeMap(ops, sourceDuration, collapsed),
    [ops, sourceDuration, collapsed],
  );
  const cutSpans = useMemo(() => mergeCutSpans(ops), [ops]);

  const render = useMemo<RenderPeaks | undefined>(() => {
    if (!sourcePeaks) return undefined;
    if (timeMap.identity) return sourceRenderPeaks(sourcePeaks);
    return sliceEditedPeaks(sourcePeaks, timeMap.keptSpans, timeMap.editedTotal);
  }, [sourcePeaks, timeMap]);

  const { wavesurfer, regions, isReady, error, controller } = useWaveformEngine({
    container: containerRef,
    projectId,
    render,
    timeMap,
    cutSpans,
  });

  const value = useMemo<WaveformContextValue>(
    () => ({
      containerRef,
      wavesurfer,
      regions,
      controller,
      timeMap,
      isReady,
      isLoadingPeaks: peaksQuery.isPending,
      error: error ?? (peaksQuery.error as Error | null),
    }),
    [
      wavesurfer,
      regions,
      controller,
      timeMap,
      isReady,
      peaksQuery.isPending,
      peaksQuery.error,
      error,
    ],
  );

  return <WaveformContext.Provider value={value}>{children}</WaveformContext.Provider>;
}

/** Read the waveform context. Throws if used outside `WaveformProvider`. */
export function useWaveformContext(): WaveformContextValue {
  const ctx = useContext(WaveformContext);
  if (!ctx) throw new Error("useWaveformContext must be used within a WaveformProvider");
  return ctx;
}
