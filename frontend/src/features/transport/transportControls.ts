/**
 * Imperative transport actions shared by the transport bar buttons and the keyboard
 * shortcuts. Zoom writes only to `playbackStore`; `useWavesurfer` has an effect that applies
 * the store's zoom to the live instance, so there is a single application path.
 */
import { ZOOM_FACTOR, clampZoom, usePlaybackStore } from "@/stores/playbackStore";
import type WaveSurfer from "wavesurfer.js";

export function togglePlay(ws: WaveSurfer | null): void {
  if (!ws) return;
  void ws.playPause();
}

export function zoomIn(): void {
  const { zoom, zoomMin, setZoom } = usePlaybackStore.getState();
  if (zoom != null) setZoom(clampZoom(zoom * ZOOM_FACTOR, zoomMin));
}

export function zoomOut(): void {
  const { zoom, zoomMin, setZoom } = usePlaybackStore.getState();
  if (zoom != null) setZoom(clampZoom(zoom / ZOOM_FACTOR, zoomMin));
}
