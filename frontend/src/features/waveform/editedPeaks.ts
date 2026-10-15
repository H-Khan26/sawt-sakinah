/**
 * Waveform levels for the renderer: the decoded source levels and the collapsed (edited) view.
 *
 * The backend serves one immutable set of source levels: RMS per fixed-length bucket, already
 * scaled to the recording (see `service/waveform.py`). Rather than round-trip the server on every
 * cut, the edited view resamples them at the same rate: each output bucket's centre on the edited
 * timeline maps back to a source time and takes the source bucket there. Positions come from the
 * exact span boundaries, so joins never accumulate drift; the audio and the cut coordinates
 * themselves stay sample-accurate.
 */
import type { WaveformPeaks } from "@/types/api";
import type { Span } from "./timeMap";

/** The decoded source levels (`0..1`, where 1 is the recording's full height). */
export interface SourceLevels {
  levels: Float32Array;
  /** Buckets per second. */
  rate: number;
  duration: number;
  /** Level of full height in dBFS RMS; fixed per recording. */
  scaleDb: number;
}

/** The level envelope + duration handed to the wavesurfer renderer. */
export interface RenderPeaks {
  levels: Float32Array;
  duration: number;
}

/** Decode the backend's base64 byte levels into `0..1` floats. */
export function decodeWaveform(raw: WaveformPeaks): SourceLevels {
  const bytes = atob(raw.levels);
  const levels = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) levels[i] = bytes.charCodeAt(i) / 255;
  return { levels, rate: raw.rate, duration: raw.duration_sec, scaleDb: raw.scale_db };
}

/** The source levels unchanged, as `RenderPeaks` (the identity / show-deleted case). */
export function sourceRenderPeaks(source: SourceLevels): RenderPeaks {
  return { levels: source.levels, duration: source.duration };
}

/** Resample `source` onto the edited timeline made of `keptSpans` (source-time spans). */
export function sliceEditedPeaks(
  source: SourceLevels,
  keptSpans: Span[],
  editedTotal: number,
): RenderPeaks {
  const { levels, rate } = source;
  const n = levels.length;
  if (n === 0 || keptSpans.length === 0)
    return { levels: new Float32Array(0), duration: editedTotal };
  // At least one bucket: wavesurfer can't render an empty channel.
  const count = Math.max(1, Math.round(editedTotal * rate));
  const out = new Float32Array(count);

  let span = 0;
  // Edited time at which `keptSpans[span]` begins.
  let spanStart = 0;
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / rate;
    while (span < keptSpans.length - 1) {
      const length = keptSpans[span][1] - keptSpans[span][0];
      if (t < spanStart + length) break;
      spanStart += length;
      span++;
    }
    const [a, b] = keptSpans[span];
    // Stay within the buckets that overlap the span, so no deleted audio shows at its end.
    const j = Math.min(Math.floor((a + t - spanStart) * rate), Math.ceil(b * rate) - 1);
    out[i] = levels[Math.min(n - 1, Math.max(0, j))];
  }
  return { levels: out, duration: editedTotal };
}
