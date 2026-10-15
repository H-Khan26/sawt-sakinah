/**
 * The popover a seam chip opens (see `SeamLayer`): a small waveform of the removed audio, its
 * length and where it sat in the original recording, and what can be done from the seam.
 *
 * - **Play removed** auditions the cut audio itself, after half a second of the kept audio before
 *   it, then stops; the mini waveform fills as it plays. The main cursor stays parked at the seam
 *   meanwhile, since cut audio maps onto the join.
 * - **Play the join** plays two seconds either side of the seam as the edit sounds, cuts skipped.
 * - **Restore** brings the whole range back (one undo step).
 * - **Show in full view** switches to the full view, brings the range into view and selects it,
 *   so its edge grips can be dragged.
 *
 * Either audition returns the playhead to the seam when it ends; pressing its button again,
 * Escape, or closing the popover stops it. Keys pressed inside stay inside (the editor's global
 * shortcuts don't see them); Escape closes and returns focus to the chip. An outside click closes
 * too, stopping the audition only after the click has done its own work, so a click on the
 * transport or the waveform takes over from it as its key would. `SeamLayer` closes the popover
 * when the seam scrolls out of view or an edit removes it.
 */
import { Button } from "@/components/ui";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import type { SourceLevels } from "@/features/waveform/editedPeaks";
import type { Span } from "@/lib/edl";
import { useThemeColors } from "@/lib/themeColors";
import { useEditStore } from "@/stores/editStore";
import { type Audition, usePlaybackStore } from "@/stores/playbackStore";
import { useViewPrefs } from "@/stores/viewPrefs";
import { Eye, Play, RotateCcw, Square } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { cutKey } from "./cutEdl";
import { type CutSeam, originalRange } from "./seams";
import { useCutCommands } from "./useCutCommands";

/** Width of the popover, in px. */
export const SEAM_POPOVER_WIDTH = 336;
/** Kept audio played before the removed audio, in seconds. */
const LEAD_IN_SEC = 0.5;
/** Audio played either side of the seam by "Play the join", in seconds (edited time). */
const JOIN_CONTEXT_SEC = 2;
/** Height of the mini waveform, in px. */
const WAVE_PX = 56;
/** Bar width and gap of the mini waveform, in px. */
const BAR_PX = 2;
const BAR_GAP_PX = 1;

type WaveColors = ReturnType<typeof useThemeColors>["waveformColors"];

/**
 * Draw the levels of source `[a, b]` onto `canvas` as mirrored bars on the main waveform's scale,
 * the first `progress` (0..1) of them in the played colour.
 */
function drawRemoved(
  canvas: HTMLCanvasElement,
  source: SourceLevels | undefined,
  [a, b]: Span,
  colors: WaveColors,
  progress: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
  if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (!source || b <= a) return;

  const { levels, rate } = source;
  const bars = Math.max(1, Math.floor(width / (BAR_PX + BAR_GAP_PX)));
  for (let i = 0; i < bars; i++) {
    // The loudest bucket under this bar, or the one it falls in when buckets are wider.
    const from = Math.floor((a + ((b - a) * i) / bars) * rate);
    const to = Math.max(from + 1, Math.ceil((a + ((b - a) * (i + 1)) / bars) * rate));
    let peak = 0;
    for (let j = Math.max(0, from); j < Math.min(levels.length, to); j++) {
      peak = Math.max(peak, levels[j]);
    }
    const barHeight = Math.max(1, peak * height);
    ctx.fillStyle = (i + 0.5) / bars < progress ? colors.played : colors.unplayed;
    ctx.fillRect(i * (BAR_PX + BAR_GAP_PX), (height - barHeight) / 2, BAR_PX, barHeight);
  }
}

/** The removed audio's waveform, filling in as "Play removed" plays it. */
function RemovedWave({ span, auditioning }: { span: Span; auditioning: boolean }) {
  const { sourceLevels } = useWaveformContext();
  const { waveformColors } = useThemeColors();
  const ref = useRef<HTMLCanvasElement>(null);
  const [a, b] = span;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const progress = (sourceTime: number) =>
      auditioning ? Math.min(1, Math.max(0, (sourceTime - a) / (b - a))) : 0;
    const draw = (sourceTime: number) =>
      drawRemoved(canvas, sourceLevels, [a, b], waveformColors, progress(sourceTime));
    draw(usePlaybackStore.getState().sourceTime);
    if (!auditioning) return;
    // Redraw straight from the per-frame playhead, so playback never re-renders React.
    return usePlaybackStore.subscribe((s, prev) => {
      if (s.sourceTime !== prev.sourceTime) draw(s.sourceTime);
    });
  }, [sourceLevels, a, b, waveformColors, auditioning]);

  return (
    <div aria-hidden="true" className="border-y border-gold/70 bg-background/60">
      <canvas ref={ref} className="block w-full" style={{ height: WAVE_PX }} />
    </div>
  );
}

const sameSpan = (p: Span | null, q: Span): boolean => !!p && p[0] === q[0] && p[1] === q[1];

/** Which of the popover's auditions is playing, if either. */
function auditionKind(audition: Audition | null, span: Span): "removed" | "join" | null {
  if (!audition) return null;
  return sameSpan(audition.playCut, span) ? "removed" : audition.playCut ? null : "join";
}

export function SeamPopover({
  projectId,
  seam,
  left,
  caretX,
  bottom,
  onClose,
}: {
  projectId: string;
  seam: CutSeam;
  /** Offset of the popover's left edge within the overlay, in px. */
  left: number;
  /** Offset of the seam from the popover's left edge, where the caret points, in px. */
  caretX: number;
  /** Distance of the popover's bottom edge from the overlay's bottom, in px. */
  bottom: number;
  /** Close the popover; `refocus` returns focus to the seam's chip. */
  onClose: (refocus: boolean) => void;
}) {
  const { controller, timeMap } = useWaveformContext();
  const commands = useCutCommands(projectId);
  const kind = auditionKind(
    usePlaybackStore((s) => s.audition),
    seam.span,
  );
  const rootRef = useRef<HTMLDialogElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const [a, b] = seam.span;

  // Focus moves into the popover when it opens.
  useEffect(() => {
    firstRef.current?.focus({ preventScroll: true });
  }, []);

  // Closing stops whatever the popover was auditioning (a press outside defers that, below).
  const stopOnCloseRef = useRef(true);
  useEffect(
    () => () => {
      if (stopOnCloseRef.current && usePlaybackStore.getState().audition) controller.stopAudition();
    },
    [controller],
  );

  // A press outside closes it; a press on a seam chip is left to the chip, which toggles. The
  // audition stops once the press's click has run: a click that seeks, plays or pauses has
  // already ended it through the controller.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (rootRef.current?.contains(target) || target?.closest?.("[data-seam-chip]")) return;
      stopOnCloseRef.current = false;
      const stopLater = () => window.setTimeout(() => controller.stopAudition(), 0);
      window.addEventListener("pointerup", stopLater, { once: true });
      onClose(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose(true);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, controller]);

  const playRemoved = () => {
    if (kind === "removed") {
      controller.stopAudition();
      return;
    }
    // At a seam at 0 there is no kept audio before it, and the lead-in starts at the cut itself.
    const start = Math.min(a, timeMap.toSource(Math.max(0, seam.at - LEAD_IN_SEC)));
    controller.audition(start, b, { playCut: seam.span, returnTo: a });
  };

  const playJoin = () => {
    if (kind === "join") {
      controller.stopAudition();
      return;
    }
    controller.audition(
      timeMap.toSource(Math.max(0, seam.at - JOIN_CONTEXT_SEC)),
      timeMap.toSource(seam.at + JOIN_CONTEXT_SEC),
      { returnTo: a },
    );
  };

  const restore = () => {
    commands.restoreCut(seam.span);
    onClose(false);
  };

  const showInFullView = () => {
    controller.stopAudition();
    useViewPrefs.getState().setShowDeleted(true);
    controller.setSourceTime(a);
    useEditStore.getState().selectCut(cutKey(seam.span));
    controller.reveal(a, b);
    onClose(false);
  };

  return (
    <dialog
      ref={rootRef}
      open
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        // Stopped here, so the editor's shortcuts never see keys from inside the popover.
        e.stopPropagation();
        if (e.key === "Escape") onClose(true);
      }}
      className="pointer-events-auto absolute right-auto z-30 m-0 rounded border border-border bg-surface p-3 text-left text-text shadow-lg"
      style={{ left, bottom, width: SEAM_POPOVER_WIDTH }}
    >
      <RemovedWave span={seam.span} auditioning={kind === "removed"} />
      <p id={titleId} className="mt-2.5 font-sans text-sm text-text">
        <span className="font-medium">Removed {(b - a).toFixed(1)} s</span>
        <span className="text-text-secondary"> · original {originalRange(seam.span)}</span>
      </p>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          ref={firstRef}
          size="sm"
          variant="secondary"
          onClick={playRemoved}
          aria-pressed={kind === "removed"}
        >
          {kind === "removed" ? <Square size={14} /> : <Play size={14} />}
          {kind === "removed" ? "Stop" : "Play removed"}
        </Button>
        <Button size="sm" variant="secondary" onClick={playJoin} aria-pressed={kind === "join"}>
          {kind === "join" ? <Square size={14} /> : <Play size={14} />}
          {kind === "join" ? "Stop" : "Play the join"}
        </Button>
        <Button size="sm" variant="primary" onClick={restore}>
          <RotateCcw size={14} /> Restore
        </Button>
        <Button size="sm" variant="ghost" onClick={showInFullView}>
          <Eye size={14} /> Show in full view
        </Button>
      </div>
      {/* The caret points down at the seam's chip. */}
      <span
        aria-hidden="true"
        className="absolute -bottom-[5px] h-2.5 w-2.5 -translate-x-1/2 rotate-45 border-b border-r border-border bg-surface"
        style={{ left: caretX }}
      />
    </dialog>
  );
}
