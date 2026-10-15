/**
 * The waveform engine: a wavesurfer instance used purely as a *renderer* plus a separate
 * `<audio>` element that owns playback, bridged so the cursor tracks the edited timeline.
 *
 * Why the split: wavesurfer derives its cursor from `media.currentTime / getDuration()`, and
 * `getDuration()` prefers the real media duration. To draw a *collapsed* (edited) waveform we must
 * feed it edited peaks + `editedTotal` as `duration`, which only holds if it has no media of its
 * own. So wavesurfer is created without a URL (it renders from peaks and its `setTime` moves the
 * cursor directly via `renderProgress`), and a plain `<audio>` we own plays the source file. On
 * every animation frame while playing we read the source time, skip any cut span, map it through
 * the `TimeMap`, and push the edited time into the cursor and the playback store. In the
 * identity (show-deleted) map this is a no-op transform, so one code path serves both views.
 *
 * Everything outside this module addresses playback in *source* time via the returned
 * `controller`; the source<->edited mapping lives here and in `timeMap.ts` alone.
 */
import { audioUrl } from "@/api/endpoints";
import { useThemeColors } from "@/lib/themeColors";
import { formatClock, formatTimelineTime } from "@/lib/time";
import { ZOOM_MAX, clampZoom, usePlaybackStore } from "@/stores/playbackStore";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import HoverPlugin from "wavesurfer.js/plugins/hover";
import MinimapPlugin from "wavesurfer.js/plugins/minimap";
import RegionsPlugin from "wavesurfer.js/plugins/regions";
import TimelinePlugin from "wavesurfer.js/plugins/timeline";
import type { RenderPeaks } from "./editedPeaks";
import { OVERVIEW_HEIGHT, TIMELINE_HEIGHT, WAVE_HEIGHT } from "./layout";
import type { Span, TimeMap } from "./timeMap";

/** Don't retrigger a skip right at a cut's tail edge, so seeking to the end doesn't re-fire. */
const EDGE_EPSILON = 0.05;

/** Pointer travel (px) below which a press on the overview's range box counts as a click. */
const CLICK_SLOP = 3;

type WaveformColors = ReturnType<typeof useThemeColors>["waveformColors"];

/**
 * Mount the overview (Minimap plugin) into `el`: the whole recording in the theme's bar
 * colours, with the visible range as a box. A click or drag on the bars seeks; dragging the box
 * scrolls the main waveform, and a press on the box without moving seeks to that point.
 * `seekEdited` moves playback to an edited-timeline time. Returns a disposer.
 */
function mountOverview(
  ws: WaveSurfer,
  el: HTMLElement,
  colors: WaveformColors,
  seekEdited: (t: number) => void,
): () => void {
  const minimap = MinimapPlugin.create({
    container: el,
    height: OVERVIEW_HEIGHT,
    waveColor: colors.unplayed,
    progressColor: colors.played,
    cursorWidth: 0,
    barWidth: 1,
    barGap: 1,
    barRadius: 0,
    // The levels arrive scaled to the recording, so both views share one fixed scale.
    normalize: false,
    dragToSeek: true,
    // The box is a DOM element, so it takes the token directly and follows a theme change.
    overlayColor: "var(--selection-fill)",
  });
  ws.registerPlugin(minimap);

  const seekAt = (fraction: number) => seekEdited(fraction * ws.getDuration());
  const offs = [minimap.on("click", seekAt), minimap.on("drag", seekAt)];

  const box = el.querySelector<HTMLElement>('[part="minimap-overlay"]');
  const onDown = (e: PointerEvent) => {
    if (!box || e.button !== 0) return;
    e.preventDefault();
    box.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startScroll = ws.getScroll();
    const scale = ws.getWrapper().scrollWidth / Math.max(1, el.clientWidth);
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > CLICK_SLOP) moved = true;
      if (moved) ws.setScroll(startScroll + dx * scale);
    };
    const onUp = (ev: PointerEvent) => {
      box.removeEventListener("pointermove", onMove);
      box.removeEventListener("pointerup", onUp);
      box.removeEventListener("pointercancel", onUp);
      if (moved || ev.type === "pointercancel") return;
      const rect = el.getBoundingClientRect();
      seekAt(Math.min(1, Math.max(0, (ev.clientX - rect.left) / Math.max(1, rect.width))));
    };
    box.addEventListener("pointermove", onMove);
    box.addEventListener("pointerup", onUp);
    box.addEventListener("pointercancel", onUp);
  };
  if (box) {
    // The plugin leaves its box click-through; here it is the drag handle for the visible range.
    box.style.pointerEvents = "auto";
    box.addEventListener("pointerdown", onDown);
  }

  return () => {
    box?.removeEventListener("pointerdown", onDown);
    for (const off of offs) off();
    minimap.destroy();
  };
}

/** Source-time playback surface every feature drives (seek, play, read the playhead). */
export interface WaveformController {
  play(): void;
  pause(): void;
  playPause(): void;
  isPlaying(): boolean;
  /** Current playhead in source seconds. */
  getSourceTime(): number;
  /** Seek to a source time (moves audio + cursor). */
  setSourceTime(sourceT: number): void;
}

interface UseWaveformEngineArgs {
  container: RefObject<HTMLElement>;
  /** Element the overview (whole-recording minimap) renders into. */
  overview: RefObject<HTMLElement>;
  projectId: string;
  /** Peaks + duration to render (source envelope, or the collapsed edited envelope). */
  render: RenderPeaks | undefined;
  /** Source <-> edited mapping matching `render`. */
  timeMap: TimeMap;
  /** All cut spans (silence + manual), in source time — playback skips these. */
  cutSpans: Span[];
}

interface UseWaveformEngineResult {
  wavesurfer: WaveSurfer | null;
  regions: RegionsPlugin | null;
  isReady: boolean;
  error: Error | null;
  controller: WaveformController;
}

export function useWaveformEngine({
  container,
  overview,
  projectId,
  render,
  timeMap,
  cutSpans,
}: UseWaveformEngineArgs): UseWaveformEngineResult {
  const wsRef = useRef<WaveSurfer | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number>(0);
  const lastLoadedRef = useRef<RenderPeaks | null>(null);

  // Latest map / cut spans, read by the rAF loop and controller without resubscribing.
  const timeMapRef = useRef(timeMap);
  timeMapRef.current = timeMap;
  const cutSpansRef = useRef(cutSpans);
  cutSpansRef.current = cutSpans;
  const renderRef = useRef(render);
  renderRef.current = render;

  const [wavesurfer, setWavesurfer] = useState<WaveSurfer | null>(null);
  const [regions, setRegions] = useState<RegionsPlugin | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const { waveformColors } = useThemeColors();
  const colorsRef = useRef(waveformColors);
  colorsRef.current = waveformColors;
  /** The colours the live renderer was last given. */
  const appliedColorsRef = useRef<typeof waveformColors | null>(null);

  const rate = usePlaybackStore((s) => s.rate);
  const zoom = usePlaybackStore((s) => s.zoom);

  const hasRender = !!render;

  // Move the cursor + store to the edited position for the current source time.
  const syncCursor = useRef(() => {
    const audio = audioRef.current;
    const ws = wsRef.current;
    if (!audio || !ws) return;
    const edited = timeMapRef.current.toEdited(audio.currentTime);
    ws.setTime(edited);
    usePlaybackStore.getState().setPlayhead(edited, audio.currentTime);
  });

  // Per-frame loop while playing: skip cut spans, then sync the cursor to the edited time.
  const tick = useRef(() => {
    const audio = audioRef.current;
    const ws = wsRef.current;
    if (!audio || !ws) return;
    for (const [start, end] of cutSpansRef.current) {
      if (audio.currentTime >= start && audio.currentTime < end - EDGE_EPSILON) {
        audio.currentTime = end;
        break;
      }
    }
    syncCursor.current();
    if (!audio.paused && !audio.ended) rafRef.current = requestAnimationFrame(tick.current);
  });

  // Seek playback to a time on the edited timeline (a click on the waveform or the overview).
  const seekEdited = useRef((editedTime: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = timeMapRef.current.toSource(editedTime);
    if (audio.paused) syncCursor.current();
  });

  /** Unmounts the overview; replaced whenever it is re-mounted for a new theme. */
  const unmountOverviewRef = useRef<(() => void) | null>(null);

  // --- playback element (owns the audio; source-time clock) ------------------
  // One effect owns the `<audio>` and all its listeners: play/pause drive the store and the
  // per-frame loop, seek re-syncs the cursor while paused.
  useEffect(() => {
    const audio = new Audio();
    audio.preload = "auto";
    audio.src = audioUrl(projectId);
    audio.playbackRate = usePlaybackStore.getState().rate;
    audioRef.current = audio;

    const startLoop = () => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(tick.current);
    };
    const stopLoop = () => {
      cancelAnimationFrame(rafRef.current);
      syncCursor.current();
    };
    const onPlay = () => {
      usePlaybackStore.getState().setIsPlaying(true);
      startLoop();
    };
    const onPause = () => {
      usePlaybackStore.getState().setIsPlaying(false);
      stopLoop();
    };
    const onSeeked = () => {
      if (audio.paused) syncCursor.current();
    };
    const onError = () => setError(new Error("Audio playback failed to load."));
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onPause);
    audio.addEventListener("seeked", onSeeked);
    audio.addEventListener("error", onError);

    return () => {
      cancelAnimationFrame(rafRef.current);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onPause);
      audio.removeEventListener("seeked", onSeeked);
      audio.removeEventListener("error", onError);
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      audioRef.current = null;
    };
  }, [projectId]);

  // Apply the store playback rate to the live audio element.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  // --- renderer (wavesurfer, no media of its own) ----------------------------
  // Created when peaks first arrive and re-created only on a new project — never on an edit or a
  // view toggle (those flow through the reload effect below), so zoom/scroll survive edits.
  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId/hasRender are recreate triggers; render is read via a ref so edits reload below rather than rebuild.
  useEffect(() => {
    const el = container.current;
    const first = renderRef.current;
    if (!el || !first) return;

    setIsReady(false);
    setError(null);
    const regionsPlugin = RegionsPlugin.create();
    const colors = colorsRef.current;

    const ws = WaveSurfer.create({
      container: el,
      // One channel of levels; wavesurfer mirrors it about the centre line.
      peaks: [first.levels],
      duration: first.duration,
      waveColor: colors.unplayed,
      progressColor: colors.played,
      cursorColor: colors.cursor,
      cursorWidth: 2,
      barWidth: 1,
      barGap: 1,
      barRadius: 0,
      height: WAVE_HEIGHT,
      normalize: false,
      interact: true,
      // The overview's range box is the scroller; the renderer's own scrollbar stays hidden.
      hideScrollbar: true,
      plugins: [
        TimelinePlugin.create({
          height: TIMELINE_HEIGHT,
          formatTimeCallback: (sec) => formatTimelineTime(sec, renderRef.current?.duration ?? sec),
          style: { color: "var(--color-text-tertiary)", fontSize: "13px" },
        }),
        // The hover line and label are DOM elements, so they take the tokens directly and follow
        // a theme change without being re-applied.
        HoverPlugin.create({
          lineColor: "var(--waveform-hover)",
          lineWidth: 1,
          labelColor: "var(--waveform-hover-label)",
          labelBackground: "var(--waveform-hover)",
          formatTimeCallback: formatClock,
        }),
        regionsPlugin,
      ],
    });
    wsRef.current = ws;
    appliedColorsRef.current = colors;
    lastLoadedRef.current = first;
    setWavesurfer(ws);
    setRegions(regionsPlugin);
    const overviewEl = overview.current;
    if (overviewEl) {
      unmountOverviewRef.current = mountOverview(ws, overviewEl, colors, seekEdited.current);
    }

    ws.on("ready", () => {
      const store = usePlaybackStore.getState();
      const duration = renderRef.current?.duration ?? 0;
      store.setDuration(duration);
      const fitted = el.clientWidth > 0 && duration > 0 ? el.clientWidth / duration : null;
      if (fitted) {
        const min = Math.min(fitted, ZOOM_MAX);
        store.setZoomMin(min);
        store.setZoom(store.zoom == null ? min : clampZoom(store.zoom, min));
      }
      setIsReady(true);
      syncCursor.current();
    });
    // A click on the renderer seeks: map the edited click position back to source time.
    ws.on("interaction", seekEdited.current);
    ws.on("error", (err) => {
      if (err?.name === "AbortError") return;
      setError(err instanceof Error ? err : new Error(String(err)));
    });

    return () => {
      unmountOverviewRef.current?.();
      unmountOverviewRef.current = null;
      wsRef.current = null;
      lastLoadedRef.current = null;
      setWavesurfer(null);
      setRegions(null);
      setIsReady(false);
      try {
        ws.destroy();
      } catch {
        // destroy during an in-flight render can throw; the instance is gone either way.
      }
      usePlaybackStore.getState().reset();
    };
  }, [container, overview, projectId, hasRender]);

  // Re-render the waveform when the edited envelope changes (an edit, or the view toggle). Reuses
  // the instance so regions/zoom survive; the persistent "ready" handler above fires on reload and
  // re-applies duration, the zoom floor, and the cursor (reading the latest render via its ref).
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || !isReady || !render || render === lastLoadedRef.current) return;
    lastLoadedRef.current = render;
    ws.load("", [render.levels], render.duration).catch(() => {
      // A newer load / destroy superseded this one; ignore.
    });
  }, [render, isReady]);

  // Re-apply the canvas colours when the theme changes. The overview's canvases are owned by the
  // plugin, so it is mounted afresh with the new colours first; the redraw that `setOptions`
  // triggers then places its range box.
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || appliedColorsRef.current === waveformColors) return;
    appliedColorsRef.current = waveformColors;
    const overviewEl = overview.current;
    if (unmountOverviewRef.current && overviewEl) {
      unmountOverviewRef.current();
      unmountOverviewRef.current = mountOverview(
        ws,
        overviewEl,
        waveformColors,
        seekEdited.current,
      );
    }
    ws.setOptions({
      waveColor: waveformColors.unplayed,
      progressColor: waveformColors.played,
      cursorColor: waveformColors.cursor,
    });
  }, [waveformColors, overview]);

  // Apply store-driven zoom to the live renderer.
  useEffect(() => {
    if (isReady && wsRef.current && zoom != null) wsRef.current.zoom(zoom);
  }, [zoom, isReady]);

  const controller = useMemo<WaveformController>(
    () => ({
      play: () => void audioRef.current?.play().catch(() => undefined),
      pause: () => audioRef.current?.pause(),
      playPause: () => {
        const audio = audioRef.current;
        if (!audio) return;
        if (audio.paused) void audio.play().catch(() => undefined);
        else audio.pause();
      },
      isPlaying: () => !!audioRef.current && !audioRef.current.paused && !audioRef.current.ended,
      getSourceTime: () => audioRef.current?.currentTime ?? 0,
      setSourceTime: (sourceT) => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = Math.max(0, sourceT);
        syncCursor.current();
      },
    }),
    [],
  );

  return { wavesurfer, regions, isReady, error, controller };
}
