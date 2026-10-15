/**
 * The waveform surface on the ruled page: a margin for the markers' notes, then the bars between
 * a gold rule above and below with faint ruled lines behind them, and the time ruler beneath.
 * The optional `overlay` (the marker layer) spans the margin and the bars, anchored to the same
 * box the waveform draws into so time-positioned children line up with the audio; it is
 * click-through by default (children opt back in with `pointer-events`). The level scale sits at
 * the bars' right edge. All state comes from `WaveformContext`.
 *
 * The wheel navigates it: Ctrl/⌘ + wheel (and a trackpad pinch, which arrives as one) zooms a step
 * at a time; a plain or Shift + wheel scrolls it sideways, gliding to where the notches add up to;
 * a trackpad's sideways swipe scrolls it as is. When the waveform is fitted, or already at its
 * edge in that direction, the wheel is left to the page.
 */
import { Alert, WaveformLoader } from "@/components/ui";
import { zoomIn, zoomOut } from "@/features/transport/transportControls";
import type { ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";
import type WaveSurfer from "wavesurfer.js";
import { useWaveformContext } from "./WaveformContext";
import { WaveformScale } from "./WaveformScale";
import { NOTES_HEIGHT, WAVE_HEIGHT } from "./layout";
import "./waveform.css";

/** At most one zoom step per this many ms, so a trackpad's burst of wheel events is one step. */
const WHEEL_STEP_MS = 120;
/** Pixels per line of a line-based wheel delta (a mouse notch in Firefox is three lines). */
const WHEEL_LINE_PX = 40;
/** Gain on a mouse wheel turned into a sideways scroll, so a notch moves a useful stretch. */
const WHEEL_PAN_GAIN = 1.5;
/** Share of the remaining distance a glide covers per frame. */
const GLIDE_EASE = 0.3;

/**
 * Wheel navigation over `ref` (see the file comment): Ctrl/⌘ + wheel zooms in (up) or out
 * (down) stepwise; any other wheel scrolls `wavesurfer` sideways.
 */
function useWheelNavigation(ref: RefObject<HTMLElement>, wavesurfer: WaveSurfer | null) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !wavesurfer) return;
    let lastZoom = 0;
    /** Where the glide is heading, or null when none is under way. */
    let target: number | null = null;
    let raf = 0;

    const maxScroll = () =>
      Math.max(0, wavesurfer.getWrapper().scrollWidth - wavesurfer.getWidth());
    const glide = () => {
      if (target == null) return;
      const at = wavesurfer.getScroll();
      const left = target - at;
      if (Math.abs(left) <= 1) {
        wavesurfer.setScroll(target);
        target = null;
        return;
      }
      // At least a pixel a frame, so a scroll offset that rounds can't stall it.
      wavesurfer.setScroll(at + Math.sign(left) * Math.max(1, Math.abs(left) * GLIDE_EASE));
      raf = requestAnimationFrame(glide);
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const now = performance.now();
        if (e.deltaY === 0 || now - lastZoom < WHEEL_STEP_MS) return;
        lastZoom = now;
        if (e.deltaY < 0) zoomIn();
        else zoomOut();
        return;
      }
      const unit =
        e.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? WHEEL_LINE_PX
          : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? wavesurfer.getWidth()
            : 1;
      const dx = e.deltaX * unit;
      const dy = e.deltaY * unit;
      // A sideways swipe moves the waveform with the fingers; a wheel (Shift or not) glides.
      const swipe = !e.shiftKey && Math.abs(dx) > Math.abs(dy);
      const delta = swipe ? dx : (Math.abs(dx) > Math.abs(dy) ? dx : dy) * WHEEL_PAN_GAIN;
      const from = target ?? wavesurfer.getScroll();
      const to = Math.min(maxScroll(), Math.max(0, from + delta));
      // Fitted, or already at the edge this way: leave the wheel to the page.
      if (Math.abs(to - from) < 0.5) return;
      e.preventDefault();
      cancelAnimationFrame(raf);
      if (swipe) {
        target = null;
        wavesurfer.setScroll(to);
      } else {
        target = to;
        raf = requestAnimationFrame(glide);
      }
    };

    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      cancelAnimationFrame(raf);
    };
  }, [ref, wavesurfer]);
}

export function WaveformView({ overlay }: { overlay?: ReactNode }) {
  const { containerRef, wavesurfer, isReady, isLoadingPeaks, error, scaleDb } =
    useWaveformContext();
  const rootRef = useRef<HTMLDivElement>(null);
  useWheelNavigation(rootRef, wavesurfer);
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
