/**
 * Live preview of the edited timeline: while playing, jump the playhead over any cut span so
 * you hear the result the export will produce. Cuts (silence + manual) are non-destructive
 * marks, so the audio element still contains those samples — we simply seek past them.
 *
 * Only *forward* playback is skipped. A manual seek into a cut while paused is left alone (you
 * can inspect a cut region); it's skipped the moment playback next reaches it. Seeking to the
 * span end can't re-enter the same span (t lands at `end`, outside the half-open trigger
 * window), so there's no seek loop.
 */
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import type { EditOperation } from "@/types/api";
import { useEffect, useRef } from "react";
import { mergeCutSpans } from "./cutEdl";

// Don't trigger right at a span's tail edge, so `setTime(end)` doesn't immediately re-fire.
const EDGE_EPSILON = 0.05;

export function useCutSkip(ops: EditOperation[]): void {
  const { wavesurfer } = useWaveformContext();

  // Keep the merged spans in a ref so the timeupdate handler need not resubscribe on every edit.
  const spansRef = useRef<Array<[number, number]>>([]);
  spansRef.current = mergeCutSpans(ops);

  useEffect(() => {
    if (!wavesurfer) return;
    return wavesurfer.on("timeupdate", (t: number) => {
      if (!wavesurfer.isPlaying()) return;
      for (const [start, end] of spansRef.current) {
        if (t >= start && t < end - EDGE_EPSILON) {
          wavesurfer.setTime(end);
          return;
        }
      }
    });
  }, [wavesurfer]);
}
