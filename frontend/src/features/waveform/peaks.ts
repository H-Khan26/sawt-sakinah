/**
 * Adapter from the backend's waveform peaks to the shape wavesurfer v7 expects.
 *
 * The backend returns two separate per-bucket arrays of float32 PCM values already in
 * `[-1, 1]` (`min[]` = the negative lobe, `max[]` = the positive lobe; see
 * `service/waveform.py`). wavesurfer's bar renderer reads `channelData[0]` as the top
 * envelope and `channelData[1]` as the bottom, both via `Math.abs`, so passing
 * `[max, min]` reproduces the true min/max envelope with no normalization. When the two
 * arrays disagree in length (shouldn't happen, but guard anyway) we fall back to the
 * `max`-only envelope, which wavesurfer mirrors — losing the negative lobe but still
 * rendering.
 *
 * Accepts any `{ min, max }` envelope — the raw source peaks or the sliced edited peaks
 * (`editedPeaks.ts`) — since both feed the same renderer.
 */
export function toWavesurferPeaks(peaks: { min: number[]; max: number[] }): number[][] {
  const { min, max } = peaks;
  if (max.length === 0) return [[]];
  if (min.length === max.length) return [max, min];
  return [max];
}
