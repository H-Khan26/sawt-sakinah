/**
 * Imperative transport actions shared by the transport bar buttons and the keyboard
 * shortcuts. Zoom writes only to `playbackStore`; the waveform engine has an effect that applies
 * the store's zoom to the live renderer, so there is a single application path. Play/pause and
 * seeking go through the engine's `controller`, which owns the source-time playback element (the
 * `<audio>` clamps an over/undershoot seek to the file bounds).
 */
import type { WaveformController } from "@/features/waveform/useWaveformEngine";
import { ZOOM_FACTOR, clampZoom, usePlaybackStore } from "@/stores/playbackStore";

/** Seconds the arrow-key skip jumps by. */
export const SEEK_STEP_SEC = 5;

export function togglePlay(controller: WaveformController | null): void {
  controller?.playPause();
}

/** Seek relative to the current position by `delta` seconds (in source time). */
export function seekBy(controller: WaveformController | null, delta: number): void {
  if (!controller) return;
  controller.setSourceTime(controller.getSourceTime() + delta);
}

export function zoomIn(): void {
  const { zoom, zoomMin, setZoom } = usePlaybackStore.getState();
  if (zoom != null) setZoom(clampZoom(zoom * ZOOM_FACTOR, zoomMin));
}

export function zoomOut(): void {
  const { zoom, zoomMin, setZoom } = usePlaybackStore.getState();
  if (zoom != null) setZoom(clampZoom(zoom / ZOOM_FACTOR, zoomMin));
}
