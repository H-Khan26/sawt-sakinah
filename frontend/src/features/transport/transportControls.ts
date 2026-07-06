/**
 * Imperative transport actions shared by the transport bar buttons and the keyboard
 * shortcuts. Zoom writes only to `playbackStore`; `useWavesurfer` has an effect that applies
 * the store's zoom to the live instance, so there is a single application path.
 */
import { ZOOM_FACTOR, clampZoom, usePlaybackStore } from "@/stores/playbackStore";
import type WaveSurfer from "wavesurfer.js";

/** Seconds the arrow-key skip jumps by. */
export const SEEK_STEP_SEC = 5;

export function togglePlay(ws: WaveSurfer | null): void {
  if (!ws) return;
  void ws.playPause();
}

/** Seek relative to the current position by `delta` seconds, clamped to the file bounds. */
export function seekBy(ws: WaveSurfer | null, delta: number): void {
  if (!ws) return;
  const duration = ws.getDuration();
  if (!duration) return;
  const next = Math.min(duration, Math.max(0, ws.getCurrentTime() + delta));
  ws.setTime(next);
}

export function zoomIn(): void {
  const { zoom, zoomMin, setZoom } = usePlaybackStore.getState();
  if (zoom != null) setZoom(clampZoom(zoom * ZOOM_FACTOR, zoomMin));
}

export function zoomOut(): void {
  const { zoom, zoomMin, setZoom } = usePlaybackStore.getState();
  if (zoom != null) setZoom(clampZoom(zoom / ZOOM_FACTOR, zoomMin));
}
