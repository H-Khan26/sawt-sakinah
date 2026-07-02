/**
 * Tracks the waveform's current time-to-pixel mapping so the marker overlay can place each
 * marker at the right x. The frontend never remaps time (markers live on the original source
 * timeline); this only projects a source time onto a screen position under the live zoom and
 * horizontal scroll.
 *
 * The rendered pixels-per-second is the *ground truth* read from the DOM (the wavesurfer
 * wrapper's `scrollWidth / duration`), not the store's `minPxPerSec` — when the waveform is
 * fitted to the container the two differ. Layout is recomputed on the events that change it
 * (zoom, scroll/pan, container resize), coalesced into a single animation frame.
 */
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { useEffect, useState } from "react";

export interface MarkerLayout {
  /** Rendered pixels per second of the waveform. */
  pxPerSec: number;
  /** Current horizontal scroll offset, in pixels. */
  scrollLeft: number;
  /** Visible width of the waveform viewport, in pixels. */
  width: number;
}

export function useMarkerLayout(): MarkerLayout | null {
  const { wavesurfer, isReady } = useWaveformContext();
  const [layout, setLayout] = useState<MarkerLayout | null>(null);

  useEffect(() => {
    if (!wavesurfer || !isReady) return;

    let raf = 0;
    const recompute = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const duration = wavesurfer.getDuration();
        const width = wavesurfer.getWidth();
        const contentWidth = wavesurfer.getWrapper().scrollWidth || width;
        setLayout({
          pxPerSec: duration > 0 ? contentWidth / duration : 0,
          scrollLeft: wavesurfer.getScroll(),
          width,
        });
      });
    };

    recompute();
    const subs = [
      wavesurfer.on("zoom", recompute),
      wavesurfer.on("scroll", recompute),
      wavesurfer.on("resize", recompute),
    ];
    return () => {
      cancelAnimationFrame(raf);
      for (const unsub of subs) unsub();
    };
  }, [wavesurfer, isReady]);

  return layout;
}
