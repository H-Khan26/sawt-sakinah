/**
 * wavesurfer v7 lifecycle wrapper.
 *
 * The instance lives in a ref (never React state) and is created/destroyed inside a single
 * effect so StrictMode's double-invoke is safe: each mount creates, each cleanup destroys.
 * High-frequency events (`timeupdate`, `play`/`pause`) are pushed into `playbackStore`, not
 * React state, so the editor tree does not re-render per frame. Playback rate and zoom are
 * driven *from* the store (the transport writes them) and applied to the instance via small
 * effects, keeping the store the single source of truth for those controls.
 */
import { audioUrl } from "@/api/endpoints";
import { waveformColors } from "@/lib/themeColors";
import { formatClock } from "@/lib/time";
import { clampZoom, usePlaybackStore } from "@/stores/playbackStore";
import type { WaveformPeaks } from "@/types/api";
import { type RefObject, useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import HoverPlugin from "wavesurfer.js/plugins/hover";
import RegionsPlugin from "wavesurfer.js/plugins/regions";
import TimelinePlugin from "wavesurfer.js/plugins/timeline";
import { toWavesurferPeaks } from "./peaks";

interface UseWavesurferArgs {
  container: RefObject<HTMLElement>;
  projectId: string;
  /** Precomputed peaks; while undefined (still fetching) no instance is created. */
  peaks: WaveformPeaks | undefined;
}

interface UseWavesurferResult {
  wavesurfer: WaveSurfer | null;
  /** Regions plugin instance; the silence layer reconciles silence overlays onto it. */
  regions: RegionsPlugin | null;
  isReady: boolean;
  error: Error | null;
}

export function useWavesurfer({
  container,
  projectId,
  peaks,
}: UseWavesurferArgs): UseWavesurferResult {
  const wsRef = useRef<WaveSurfer | null>(null);
  const [wavesurfer, setWavesurfer] = useState<WaveSurfer | null>(null);
  const [regions, setRegions] = useState<RegionsPlugin | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const rate = usePlaybackStore((s) => s.rate);
  const zoom = usePlaybackStore((s) => s.zoom);

  // Create / destroy. Keyed on the audio identity (projectId) and the peaks object so a new
  // project or recomputed peaks rebuilds the instance; the store is reset on teardown. Store
  // access goes through getState() so this effect need not depend on rate/zoom (applied by
  // the two effects below).
  useEffect(() => {
    const el = container.current;
    if (!el || !peaks) return;

    const store = usePlaybackStore.getState();
    setIsReady(false);
    setError(null);

    // Read-only silence/marker overlays layer onto this plugin (drag/resize per-region).
    const regionsPlugin = RegionsPlugin.create();

    const ws = WaveSurfer.create({
      container: el,
      url: audioUrl(projectId),
      peaks: toWavesurferPeaks(peaks),
      duration: peaks.duration_sec,
      waveColor: waveformColors.unplayed,
      progressColor: waveformColors.played,
      cursorColor: waveformColors.cursor,
      cursorWidth: 2,
      height: 128,
      // Peaks are already in [-1, 1]; do not renormalize per-render.
      normalize: false,
      interact: true,
      plugins: [
        TimelinePlugin.create({
          height: 18,
          formatTimeCallback: formatClock,
          style: { color: "var(--color-text-tertiary)" },
        }),
        HoverPlugin.create({
          lineColor: waveformColors.hover,
          lineWidth: 1,
          labelColor: "#ffffff",
          labelBackground: waveformColors.hover,
          formatTimeCallback: formatClock,
        }),
        regionsPlugin,
      ],
    });
    wsRef.current = ws;
    setWavesurfer(ws);
    setRegions(regionsPlugin);

    ws.on("ready", (duration) => {
      store.setDuration(duration);
      ws.setPlaybackRate(usePlaybackStore.getState().rate, true);
      // Establish a numeric zoom baseline from the fitted layout so zoom controls have a
      // starting point (until ready, zoom is null and wavesurfer fills the container).
      const fitted = el.clientWidth > 0 && duration > 0 ? el.clientWidth / duration : null;
      if (fitted) store.setZoom(clampZoom(fitted));
      setIsReady(true);
    });
    ws.on("play", () => store.setIsPlaying(true));
    ws.on("pause", () => store.setIsPlaying(false));
    ws.on("finish", () => store.setIsPlaying(false));
    ws.on("timeupdate", (t) => store.setCurrentTime(t));
    ws.on("error", (err) => {
      // wavesurfer raises an AbortError when destroyed mid-load — that's expected teardown.
      if (err?.name === "AbortError") return;
      setError(err instanceof Error ? err : new Error(String(err)));
    });

    return () => {
      wsRef.current = null;
      setWavesurfer(null);
      setRegions(null);
      setIsReady(false);
      try {
        ws.destroy();
      } catch {
        // destroy during an in-flight load can throw; the instance is gone either way.
      }
      usePlaybackStore.getState().reset();
    };
  }, [container, projectId, peaks]);

  // Apply store-driven controls to the live instance.
  useEffect(() => {
    if (isReady && wsRef.current) wsRef.current.setPlaybackRate(rate, true);
  }, [rate, isReady]);

  useEffect(() => {
    if (isReady && wsRef.current && zoom != null) wsRef.current.zoom(zoom);
  }, [zoom, isReady]);

  return { wavesurfer, regions, isReady, error };
}
