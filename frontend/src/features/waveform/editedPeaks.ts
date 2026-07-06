/**
 * Client-side edited-waveform peaks for the collapsed view.
 *
 * The backend serves one immutable set of source peaks (min/max per bucket over the whole file).
 * Rather than round-trip the server on every cut, we slice those buckets to the kept spans and
 * concatenate them, producing the peaks of the contiguous edited timeline. This is bucket-grained
 * (a join snaps to the nearest ~duration/buckets boundary), which is imperceptible for display;
 * the audio and the cut coordinates themselves stay sample-accurate.
 */
import type { WaveformPeaks } from "@/types/api";
import type { Span } from "./timeMap";

/** The min/max envelope + duration handed to the wavesurfer renderer. */
export interface RenderPeaks {
  min: number[];
  max: number[];
  duration: number;
}

/** The source peaks unchanged, as `RenderPeaks` (the identity / show-deleted case). */
export function sourceRenderPeaks(peaks: WaveformPeaks): RenderPeaks {
  return { min: peaks.min, max: peaks.max, duration: peaks.duration_sec };
}

/** Slice `peaks` to `keptSpans` and concatenate into the collapsed edited envelope. */
export function sliceEditedPeaks(
  peaks: WaveformPeaks,
  keptSpans: Span[],
  editedTotal: number,
): RenderPeaks {
  const { min, max, duration_sec } = peaks;
  const n = max.length;
  if (n === 0 || duration_sec <= 0) return { min, max, duration: duration_sec };

  const hasMin = min.length === n;
  const outMin: number[] = [];
  const outMax: number[] = [];
  for (const [a, b] of keptSpans) {
    const i0 = Math.max(0, Math.floor((a / duration_sec) * n));
    const i1 = Math.min(n, Math.ceil((b / duration_sec) * n));
    for (let i = i0; i < i1; i++) {
      outMax.push(max[i]);
      if (hasMin) outMin.push(min[i]);
    }
  }
  return { min: hasMin ? outMin : [], max: outMax, duration: editedTotal };
}
