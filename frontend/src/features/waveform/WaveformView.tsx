/**
 * The waveform surface: the element wavesurfer draws into, plus load/error overlays. Kept
 * presentational — all state comes from `WaveformContext`. Silence regions (Phase 5) and
 * markers (Phase 6) will layer over this same container by reading the instance from
 * context, so the container is `relative` to anchor their absolutely-positioned overlays.
 */
import { Alert, LoadingSpinner } from "@/components/ui";
import { useWaveformContext } from "./WaveformContext";

export function WaveformView() {
  const { containerRef, isReady, isLoadingPeaks, error } = useWaveformContext();

  return (
    <div className="relative w-full rounded-card bg-background-secondary p-4">
      {error ? (
        <div className="p-4">
          <Alert variant="error" title="Couldn't load the waveform">
            {error.message}
          </Alert>
        </div>
      ) : null}

      {/* wavesurfer renders its canvases + timeline into this element. */}
      <div ref={containerRef} className="w-full" aria-label="Audio waveform" />

      {!error && (isLoadingPeaks || !isReady) ? (
        <div className="absolute inset-0 flex items-center justify-center rounded-card bg-background-secondary/60">
          <LoadingSpinner size={24} label="Loading waveform" />
        </div>
      ) : null}
    </div>
  );
}
