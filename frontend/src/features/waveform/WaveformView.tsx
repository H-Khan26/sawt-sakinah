/**
 * The waveform surface on the ruled page: a margin for the markers' notes, then the bars between
 * a gold rule above and below with faint ruled lines behind them, and the time ruler beneath.
 * The optional `overlay` (the marker layer) spans the margin and the bars, anchored to the same
 * box the waveform draws into so time-positioned children line up with the audio; it is
 * click-through by default (children opt back in with `pointer-events`). The level scale sits at
 * the bars' right edge. Ctrl/⌘ + wheel zooms one step at a time. All state comes from `WaveformContext`.
 */
import { Alert, WaveformLoader } from "@/components/ui";
import { zoomIn, zoomOut } from "@/features/transport/transportControls";
import type { ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";
import { useWaveformContext } from "./WaveformContext";
import { WaveformScale } from "./WaveformScale";
import { NOTES_HEIGHT, WAVE_HEIGHT } from "./layout";
import "./waveform.css";

/** At most one zoom step per this many ms, so a trackpad's burst of wheel events is one step. */
const WHEEL_STEP_MS = 120;

/** Ctrl/⌘ + wheel over `ref` zooms in (wheel up) or out (wheel down), stepwise. */
function useWheelZoom(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = 0;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const now = performance.now();
      if (e.deltaY === 0 || now - last < WHEEL_STEP_MS) return;
      last = now;
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
}

export function WaveformView({ overlay }: { overlay?: ReactNode }) {
  const { containerRef, isReady, isLoadingPeaks, error, scaleDb } = useWaveformContext();
  const rootRef = useRef<HTMLDivElement>(null);
  useWheelZoom(rootRef);
  const bars = { top: NOTES_HEIGHT, height: WAVE_HEIGHT };

  return (
    <div ref={rootRef} className="relative w-full">
      {error ? (
        <Alert variant="error" title="Couldn't load the waveform" className="mb-3">
          {error.message}
        </Alert>
      ) : null}

      <div className="relative" style={{ paddingTop: NOTES_HEIGHT }}>
        <div
          aria-hidden="true"
          className="wf-ruled pointer-events-none absolute inset-x-0 opacity-60"
          style={bars}
        />
        {/* wavesurfer renders its canvases + timeline into this element. */}
        <div
          ref={containerRef}
          className="wf-main relative z-0 w-full"
          aria-label="Audio waveform"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 z-10 border-y border-gold"
          style={bars}
        />
        {isReady && scaleDb != null ? <WaveformScale scaleDb={scaleDb} top={NOTES_HEIGHT} /> : null}
        {isReady && overlay ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 z-20 overflow-hidden"
            style={{ height: NOTES_HEIGHT + WAVE_HEIGHT }}
          >
            {overlay}
          </div>
        ) : null}
        {!error && (isLoadingPeaks || !isReady) ? (
          <div
            className="absolute inset-x-0 z-30 flex items-center justify-center bg-surface/60"
            style={bars}
          >
            <WaveformLoader size={28} label="Loading waveform" className="text-accent" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
