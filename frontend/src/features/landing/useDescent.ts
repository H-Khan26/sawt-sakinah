/**
 * Drives the Sanctuary descent from the library's scroll container. Progress is
 * `scrollTop / (h - H1)`: 0 is the landing under the dome, 1 the library with the logo in the
 * header and the lamp ring on its edge.
 *
 * Everything per frame is imperative: a scroll listener batched to animation frames writes the
 * band's height and the landing's opacity as custom properties, the logos' transforms as inline
 * styles, and the dome and lamp ring through their handles. Nothing re-renders while scrolling.
 * CSS scroll-driven animations would do this declaratively, but not every WebView pywebview uses
 * supports them.
 *
 * The landing shows once per page load (a launch: the desktop window's origin changes each launch,
 * so nothing is stored), and only when the `landing` preference is on. Until the preferences load
 * the decision waits, so a user who turned the landing off never sees the dome flash. Every other
 * mount (back from the editor, `/new`) opens on the library, already descended.
 */
import type { DomeRosetteHandle, LampRingHandle } from "@/components/ornament";
import { descentLayout, descentMetrics, lampRingGeometry } from "@/ornament/chandelier";
import { ease } from "@/ornament/ease";
import { num } from "@/ornament/num";
import { useViewPrefs } from "@/stores/viewPrefs";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/** How the library opens on this mount. */
export type Opening = "landing" | "library";

/** Length of the Enter button's descent. */
const DESCENT_MS = 700;

/** Within this many px of the top, Enter, Space and ↓ run the descent. */
const AT_TOP = 4;

/**
 * Whether this page load's launch is spent: set once the library has decided how to open. A load
 * that starts away from the library root (an editor deep link, `/new`) has no landing.
 */
let launched = window.location.pathname !== "/";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

interface Stage {
  width: number;
  height: number;
  headerHeight: number;
  R0: number;
  /** Scroll distance of the whole descent, `h - H1`. */
  run: number;
  /**
   * Scroll position last laid out at this size. A resize can clamp `scrollTop` before the stage
   * is re-measured, so the place in the descent is kept from here.
   */
  top: number;
}

export function useDescent() {
  const scroller = useRef<HTMLElement>(null);
  const dome = useRef<DomeRosetteHandle>(null);
  const lamps = useRef<LampRingHandle>(null);
  const stacked = useRef<HTMLDivElement>(null);
  const horizontal = useRef<HTMLDivElement>(null);
  const landing = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const tween = useRef(0);

  const hydrated = useViewPrefs((s) => s.hydrated);
  const landingPref = useViewPrefs((s) => s.landing);

  // Latched for the life of this mount: changing the preference later doesn't move the page.
  const opening = useRef<Opening | null>(launched ? "library" : null);
  if (opening.current === null && hydrated) opening.current = landingPref ? "landing" : "library";
  const decided = opening.current;

  /** Lays out every layer for the current scroll position. */
  const render = useCallback(() => {
    const el = scroller.current;
    const s = stage.current;
    if (!el || !s || !opening.current) return;
    const top = el.scrollTop;
    if (el.clientHeight === s.height) s.top = top;
    const input = {
      progress: s.run > 0 ? top / s.run : 1,
      width: s.width,
      height: s.height,
      headerHeight: s.headerHeight,
      R0: s.R0,
      reduceMotion: reducedMotion.matches,
    };
    const layout = descentLayout(input);
    el.style.setProperty("--band", `${num(layout.bandHeight, 2)}px`);
    el.style.setProperty("--land-op", num(layout.landingOpacity));
    if (landing.current) {
      landing.current.style.visibility = layout.landingOpacity < 0.01 ? "hidden" : "";
    }
    const { logo } = layout;
    for (const [ref, y, opacity] of [
      [stacked, logo.stackedY, logo.stackedOpacity],
      [horizontal, logo.horizontalY, logo.horizontalOpacity],
    ] as const) {
      const style = ref.current?.style;
      if (!style) continue;
      style.width = `${num(logo.width, 2)}px`;
      style.transform = `translate(${num(logo.x, 2)}px, ${num(y, 2)}px)`;
      style.opacity = num(opacity);
    }
    dome.current?.update({
      transform: { x: layout.dome.x, y: layout.dome.y, scale: layout.dome.scale },
      opacity: layout.dome.opacity,
      windowOpacity: layout.dome.windowOpacity,
      bandOpacity: layout.dome.bandOpacity,
    });
    lamps.current?.update(lampRingGeometry(input));
  }, []);

  /** Sizes the stage from the scroll container and keeps the place in the descent on a resize. */
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const width = el.clientWidth;
    const height = el.clientHeight;
    if (!width || !height) return;
    const m = descentMetrics(width, height);
    const prev = stage.current;
    const top = prev?.top ?? el.scrollTop;
    stage.current = {
      width,
      height,
      headerHeight: m.headerHeight,
      R0: m.R0,
      run: height - m.headerHeight,
      top,
    };
    el.style.setProperty("--h", `${height}px`);
    el.style.setProperty("--H1", `${m.headerHeight}px`);
    el.style.setProperty("--chand", `${m.chandelier}px`);
    if (prev && opening.current && prev.run !== stage.current.run && top > 0) {
      const run = stage.current.run;
      // Past the descent the content keeps its offset under the header; within it, the progress.
      el.scrollTop = top >= prev.run ? top + run - prev.run : (top / prev.run) * run;
    }
    render();
  }, [render]);

  const stopTween = useCallback(() => {
    cancelAnimationFrame(tween.current);
    tween.current = 0;
  }, []);

  /** Runs the descent to the library: an eased ~700 ms scroll, or a jump under reduced motion. */
  const descend = useCallback(() => {
    const el = scroller.current;
    const s = stage.current;
    if (!el || !s) return;
    stopTween();
    const from = el.scrollTop;
    const to = s.run;
    if (reducedMotion.matches || Math.abs(to - from) < 1) {
      el.scrollTop = to;
      render();
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DESCENT_MS);
      el.scrollTop = from + (to - from) * ease(t);
      render();
      tween.current = t < 1 ? requestAnimationFrame(step) : 0;
    };
    tween.current = requestAnimationFrame(step);
  }, [render, stopTween]);

  // Measures on mount (the stage's height comes from it even before the decision) and on resize.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // Once decided, opens on the landing (top) or the library (descended) before the first paint.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!decided || !el) return;
    launched = true;
    measure();
    el.scrollTop = decided === "landing" ? 0 : (stage.current?.run ?? 0);
    render();
  }, [decided, measure, render]);

  // Re-applies the frame after any render of the shell, so its initial props never stick.
  useLayoutEffect(() => {
    render();
  });

  useEffect(() => {
    const el = scroller.current;
    if (!decided || !el) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        render();
      });
    };
    // Enter, Space and ↓ at the top run the descent, whether the container or nothing has focus.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "Enter" && e.key !== " " && e.key !== "ArrowDown") return;
      const active = document.activeElement;
      if (active !== el && active !== document.body && active !== null) return;
      if (el.scrollTop >= AT_TOP) return;
      e.preventDefault();
      descend();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    // A wheel, touch or click takes over from a running descent.
    el.addEventListener("wheel", stopTween, { passive: true });
    el.addEventListener("touchstart", stopTween, { passive: true });
    el.addEventListener("pointerdown", stopTween);
    window.addEventListener("keydown", onKeyDown);
    reducedMotion.addEventListener("change", render);
    return () => {
      cancelAnimationFrame(frame);
      stopTween();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("wheel", stopTween);
      el.removeEventListener("touchstart", stopTween);
      el.removeEventListener("pointerdown", stopTween);
      window.removeEventListener("keydown", onKeyDown);
      reducedMotion.removeEventListener("change", render);
    };
  }, [decided, descend, render, stopTween]);

  return {
    /** How this mount opens, or null while the preferences load. */
    opening: decided,
    descend,
    refs: { scroller, dome, lamps, stacked, horizontal, landing },
  };
}
