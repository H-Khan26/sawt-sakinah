/**
 * Playback state, isolated from the server-data caches and the rest of the editor tree.
 *
 * `currentTime` updates on every animation frame during playback; components that need it
 * (the transport readout, the future active-position indicator) subscribe to *just that
 * slice* via a selector so the editor tree does not re-render per frame. Nothing here is
 * server state — it is fed from wavesurfer's own events by `useWavesurfer`.
 */
import { create } from "zustand";

/** Zoom is expressed as wavesurfer's `minPxPerSec`. `null` = fit-to-container (initial). */
export const ZOOM_MIN = 10;
export const ZOOM_MAX = 1000;
/** Multiplicative step for the zoom in/out controls. */
export const ZOOM_FACTOR = 1.5;

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5] as const;

interface PlaybackState {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  rate: number;
  /** Current `minPxPerSec`; `null` until the waveform is first laid out (fit-to-width). */
  zoom: number | null;

  setCurrentTime: (t: number) => void;
  setDuration: (d: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setRate: (rate: number) => void;
  setZoom: (zoom: number) => void;
  /** Reset to defaults when the editor unmounts or the project changes. */
  reset: () => void;
}

const INITIAL = {
  currentTime: 0,
  duration: 0,
  isPlaying: false,
  rate: 1,
  zoom: null as number | null,
};

export const usePlaybackStore = create<PlaybackState>((set) => ({
  ...INITIAL,
  setCurrentTime: (currentTime) => set({ currentTime }),
  setDuration: (duration) => set({ duration }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setRate: (rate) => set({ rate }),
  setZoom: (zoom) => set({ zoom }),
  reset: () => set(INITIAL),
}));

/** Clamp a candidate `minPxPerSec` to the supported zoom range. */
export const clampZoom = (px: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, px));
