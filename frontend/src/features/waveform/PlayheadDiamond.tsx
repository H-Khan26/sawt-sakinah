/**
 * The playhead's diamond: a small rotated square sitting on the top rule above wavesurfer's own
 * cursor line. It follows the per-frame time in `playbackStore` through a subscription that
 * writes the transform straight to the element, so playback never re-renders React; zoom and
 * scroll (which change the mapping) come from `useOverlayLayout`.
 */
import { usePlaybackStore } from "@/stores/playbackStore";
import { useEffect, useRef } from "react";
import { NOTES_HEIGHT } from "./layout";
import { useOverlayLayout } from "./useOverlayLayout";

/** Side of the square before rotation, in px. */
const SIZE = 10;

export function PlayheadDiamond() {
  const layout = useOverlayLayout();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!layout) return;
    const place = (time: number) => {
      const el = ref.current;
      if (!el) return;
      const x = time * layout.pxPerSec - layout.scrollLeft;
      const visible = x >= -SIZE && x <= layout.width + SIZE;
      el.style.visibility = visible ? "visible" : "hidden";
      // Centred on wavesurfer's 2 px cursor, whose left edge sits at x.
      el.style.transform = `translateX(${x + 1 - SIZE / 2}px) rotate(45deg)`;
    };
    place(usePlaybackStore.getState().currentTime);
    return usePlaybackStore.subscribe((s, prev) => {
      if (s.currentTime !== prev.currentTime) place(s.currentTime);
    });
  }, [layout]);

  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="wf-diamond absolute left-0 bg-[color:var(--waveform-cursor)]"
      style={{ top: NOTES_HEIGHT - SIZE / 2, width: SIZE, height: SIZE, visibility: "hidden" }}
    />
  );
}
