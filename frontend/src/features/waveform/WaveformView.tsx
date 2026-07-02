/**
 * The waveform surface: the element wavesurfer draws into, plus load/error overlays and an
 * optional `overlay` slot layered over the waveform (the Phase 6 marker layer). The overlay
 * is anchored to the same box the waveform draws into so time-positioned children line up
 * with the audio; it is click-through by default (children opt back in with `pointer-events`).
 * Kept presentational — all state comes from `WaveformContext`.
 */
import { Alert, LoadingSpinner } from "@/components/ui";
import type { ReactNode } from "react";
import { useWaveformContext } from "./WaveformContext";

export function WaveformView({ overlay }: { overlay?: ReactNode }) {
  const { containerRef, isReady, isLoadingPeaks, error } = useWaveformContext();

  return (
    <div className="relative w-full rounded-card bg-background-secondary px-2 py-4">
      {error ? (
        <div className="p-4">
          <Alert variant="error" title="Couldn't load the waveform">
            {error.message}
          </Alert>
        </div>
      ) : null}

      <div className="relative">
        {/* wavesurfer renders its canvases + timeline into this element. */}
        <div ref={containerRef} className="w-full" aria-label="Audio waveform" />
        {isReady && overlay ? (
          <div className="pointer-events-none absolute inset-0 overflow-hidden">{overlay}</div>
        ) : null}
      </div>

      {!error && (isLoadingPeaks || !isReady) ? (
        <div className="absolute inset-0 flex items-center justify-center rounded-card bg-background-secondary/60">
          <LoadingSpinner size={24} label="Loading waveform" />
        </div>
      ) : null}
    </div>
  );
}
