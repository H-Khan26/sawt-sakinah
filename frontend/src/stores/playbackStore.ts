/**
 * Playback state, isolated from the server-data caches and the rest of the editor tree.
 *
 * `currentTime` and `duration` are in *edited* time (the collapsed timeline the waveform shows);
 * they equal source time when deleted portions are shown. `currentTime` updates every animation
 * frame during playback; components that need it (the transport readout) subscribe to *just that
 * slice* via a selector so the editor tree does not re-render per frame. Nothing here is server
 * state — the waveform engine (`useWaveformEngine`) feeds it from the playback element.
 *
 * `audition` is the stretch of playback the engine is auditioning (see
 * `WaveformController.audition`), or null; its progress is `sourceTime` within it.
 */
import { create } from "zustand";

/** Zoom is expressed as wavesurfer's `minPxPerSec`. `null` = fit-to-container (initial). */
/** Absolute fallback floor, used only until the fit-to-width min is computed on `ready`. */
export const ZOOM_MIN = 10;
export const ZOOM_MAX = 1000;
/** Multiplicative step for the zoom in/out controls. */
export const ZOOM_FACTOR = 1.5;

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5] as const;

/** A stretch of source time played once and stopped (see `WaveformController.audition`). */
export interface Audition {
  /** Source seconds it plays from and to. */
  start: number;
  end: number;
  /** The cut range heard rather than skipped, or null when every cut is skipped. */
  playCut: [number, number] | null;
}

interface PlaybackState {
  currentTime: number;
  /** The playhead on the source timeline (seconds), alongside the edited `currentTime`. */
  sourceTime: number;
  duration: number;
  isPlaying: boolean;
  rate: number;
  /** Current `minPxPerSec`; `null` until the waveform is first laid out (fit-to-width). */
  zoom: number | null;
  /** Most-zoomed-out `minPxPerSec` for the loaded file (fit-to-width); recomputed on ready. */
  zoomMin: number;
  /** The audition playing now, or null. */
  audition: Audition | null;

  /** Set the playhead: its edited time and the source time it maps from. */
  setPlayhead: (edited: number, source: number) => void;
  setDuration: (d: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setRate: (rate: number) => void;
  setZoom: (zoom: number) => void;
  setZoomMin: (zoomMin: number) => void;
  setAudition: (audition: Audition | null) => void;
  /** Reset to defaults when the editor unmounts or the project changes. */
  reset: () => void;
}

const INITIAL = {
  currentTime: 0,
  sourceTime: 0,
  duration: 0,
  isPlaying: false,
  rate: 1,
  zoom: null as number | null,
  zoomMin: ZOOM_MIN,
  audition: null as Audition | null,
};

export const usePlaybackStore = create<PlaybackState>((set) => ({
  ...INITIAL,
  setPlayhead: (currentTime, sourceTime) => set({ currentTime, sourceTime }),
  setDuration: (duration) => set({ duration }),
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setRate: (rate) => set({ rate }),
  setZoom: (zoom) => set({ zoom }),
  setZoomMin: (zoomMin) => set({ zoomMin }),
  setAudition: (audition) => set({ audition }),
  reset: () => set(INITIAL),
}));

/**
 * Clamp a candidate `minPxPerSec` to the supported zoom range. The floor defaults to the
 * absolute fallback but callers pass the file's fit-to-width `zoomMin` so zoom-out can reach
 * the whole-file view.
 */
export const clampZoom = (px: number, min: number = ZOOM_MIN): number =>
  Math.min(ZOOM_MAX, Math.max(min, px));
