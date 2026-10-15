/**
 * Seams in the collapsed view: at each join where cut audio was taken out, a thin line through
 * the bars and a chip on the bottom rule giving the removed length (`−4.2 s`). The chip's tooltip
 * names the range in the original recording; clicking it opens the seam's popover
 * (`SeamPopover`) to audition, restore or inspect the removed audio. Nothing is drawn in the full
 * view, where the removed ranges themselves are.
 *
 * Positioned like every waveform overlay: each seam's edited time projected to x under the live zoom
 * and scroll (`useOverlayLayout`), in `WaveformView`'s overlay slot. Where seams crowd, a chip
 * whose label would run into the one before moves up a row, then shrinks to a small diamond, and
 * one too close even for that keeps only its line, so a dense, zoomed-out view stays legible.
 * The seam the paused playhead is parked at (after `,` / `.`, or an audition) and the open one
 * are drawn stronger.
 */
import { Tooltip, type TooltipAlign } from "@/components/ui";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { NOTES_HEIGHT } from "@/features/waveform/layout";
import { useOverlayLayout } from "@/features/waveform/useOverlayLayout";
import { cn } from "@/lib/cn";
import { formatClockPrecise } from "@/lib/time";
import { usePlaybackStore } from "@/stores/playbackStore";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SEAM_POPOVER_WIDTH, SeamPopover } from "./SeamPopover";
import { cutKey } from "./cutEdl";
import { type CutSeam, cutSeams, originalRange, removedLabel } from "./seams";

/** Keep seams just off-screen so a partly-visible chip still renders. */
const OFFSCREEN_MARGIN = 48;
/** The chip's height, its gap above the bottom rule, and the step up to the second row, in px. */
const CHIP_HEIGHT = 20;
const CHIP_BOTTOM = 6;
const CHIP_ROW_PX = CHIP_HEIGHT + 4;
/** Rows of chips; a chip that fits in none shrinks to a diamond. */
const CHIP_ROWS = 2;
/** Rough width of a chip: padding plus a 12 px tabular character. */
const CHIP_BASE_PX = 14;
const CHIP_CHAR_PX = 6.6;
/** Hit box of a crowded seam's diamond, in px. */
const PIP_PX = 14;
/** Space kept clear after a chip before the next one may show. */
const CHIP_GAP_PX = 6;
/** Lines closer than this (px) to the previous one are not drawn. */
const LINE_GAP_PX = 2;
/** A seam closer than this to its edge of the view aligns its tooltip inward, in px. */
const TOOLTIP_EDGE_PX = 130;
/** Margin kept between the popover and the sides of the view, in px. */
const POPOVER_INSET_PX = 8;
/** Gap between the popover and the chip beneath it, in px. */
const POPOVER_GAP_PX = 8;
/** The caret keeps this far (px) from the popover's corners. */
const CARET_INSET_PX = 14;
/** A paused playhead this close (seconds) to a seam's range start is parked at the seam. */
const PARKED_EPSILON = 1e-3;

/** How a seam is drawn: its line, and its chip (a label or a diamond, in a row) if it has room. */
interface PlacedSeam {
  seam: CutSeam;
  key: string;
  x: number;
  label: string;
  line: boolean;
  chip: { kind: "label" | "pip"; row: number } | null;
}

/**
 * Lay out seams left to right (`xs` in px, ascending): each label takes the first row where it
 * clears the chip before it, else a diamond the first row it clears; lines closer than
 * `LINE_GAP_PX` are dropped unless `keep` holds for their seam.
 */
function placeSeams(
  seams: CutSeam[],
  xs: number[],
  keep: (seam: CutSeam) => boolean,
): PlacedSeam[] {
  const rowFrom = Array<number>(CHIP_ROWS).fill(Number.NEGATIVE_INFINITY);
  let lineAt = Number.NEGATIVE_INFINITY;
  return seams.map((seam, i) => {
    const x = xs[i];
    const key = cutKey(seam.span);
    const label = removedLabel(seam.span);
    const fits = (width: number) => rowFrom.findIndex((from) => x - width / 2 >= from);
    const labelWidth = CHIP_BASE_PX + label.length * CHIP_CHAR_PX;
    const labelRow = fits(labelWidth);
    const pipRow = labelRow < 0 ? fits(PIP_PX) : -1;
    const chip =
      labelRow >= 0
        ? { kind: "label" as const, row: labelRow }
        : pipRow >= 0
          ? { kind: "pip" as const, row: pipRow }
          : null;
    if (chip) {
      rowFrom[chip.row] = x + (chip.kind === "label" ? labelWidth : PIP_PX) / 2 + CHIP_GAP_PX;
    }
    const line = keep(seam) || x - lineAt >= LINE_GAP_PX;
    if (line) lineAt = x;
    return { seam, key, x, label, line, chip };
  });
}

export function SeamLayer({ projectId }: { projectId: string }) {
  const { timeMap, cutSpans } = useWaveformContext();
  const layout = useOverlayLayout();
  // Only while paused, so playback doesn't re-render the layer every frame.
  const parkedAt = usePlaybackStore((s) => (s.isPlaying ? null : s.sourceTime));
  const [openKey, setOpenKey] = useState<string | null>(null);
  const chips = useRef(new Map<string, HTMLButtonElement>());

  const seams = useMemo(
    () => (timeMap.identity ? [] : cutSeams(cutSpans, timeMap)),
    [cutSpans, timeMap],
  );

  const visible = (x: number) =>
    !!layout && x >= -OFFSCREEN_MARGIN && x <= layout.width + OFFSCREEN_MARGIN;
  const xOf = (at: number) => (layout ? at * layout.pxPerSec - layout.scrollLeft : 0);

  // The open seam closes once an edit removes or reshapes it (its key changes) or the view
  // switches.
  const open = seams.find((seam) => cutKey(seam.span) === openKey) ?? null;
  useEffect(() => {
    if (openKey && !open) setOpenKey(null);
  }, [openKey, open]);

  // It also closes when a scroll or zoom takes it out of view, unless an audition is playing:
  // following that playback may carry the seam off screen, and the audition returns to it.
  const openX = open ? xOf(open.at) : null;
  const openOffscreen = openX != null && !visible(openX);
  // biome-ignore lint/correctness/useExhaustiveDependencies: layout is the trigger; openOffscreen is read as of that change
  useEffect(() => {
    if (openOffscreen && !usePlaybackStore.getState().audition) setOpenKey(null);
  }, [layout]);

  const close = useCallback(
    (refocus: boolean) => {
      if (refocus && openKey) chips.current.get(openKey)?.focus();
      setOpenKey(null);
    },
    [openKey],
  );

  if (!layout || layout.pxPerSec <= 0 || seams.length === 0) return null;

  const isParked = (seam: CutSeam) =>
    parkedAt != null && Math.abs(parkedAt - seam.span[0]) < PARKED_EPSILON;
  const shown = seams.filter((seam) => visible(xOf(seam.at)));
  const placed = placeSeams(
    shown,
    shown.map((seam) => xOf(seam.at)),
    (seam) => cutKey(seam.span) === openKey || isParked(seam),
  );
  // The popover centres on its seam, kept inside the view, above the seam's chip.
  const popoverLeft = Math.min(
    Math.max(POPOVER_INSET_PX, (openX ?? 0) - SEAM_POPOVER_WIDTH / 2),
    layout.width - SEAM_POPOVER_WIDTH - POPOVER_INSET_PX,
  );
  const openRow = placed.find((p) => p.key === openKey)?.chip?.row ?? 0;

  return (
    <>
      {placed.map(({ seam, key, x, label, line, chip }) => {
        if (!line && !chip) return null;
        const isOpen = key === openKey;
        const strong = isOpen || isParked(seam);
        const seconds = (seam.span[1] - seam.span[0]).toFixed(1);
        const align: TooltipAlign =
          x < TOOLTIP_EDGE_PX ? "start" : x > layout.width - TOOLTIP_EDGE_PX ? "end" : "center";
        return (
          <div key={key} className="absolute inset-y-0" style={{ left: `${x}px` }}>
            {line && (
              <div
                className={cn(
                  "absolute bottom-0 -translate-x-1/2",
                  strong ? "w-0.5 bg-danger" : "w-px bg-danger/50",
                )}
                style={{ top: NOTES_HEIGHT }}
              />
            )}
            {chip && (
              <div
                className="absolute -translate-x-1/2"
                style={{ bottom: CHIP_BOTTOM + chip.row * CHIP_ROW_PX }}
              >
                <Tooltip
                  content={`Removed ${originalRange(seam.span)} of the original`}
                  align={align}
                  disabled={isOpen}
                >
                  <button
                    ref={(el) => {
                      if (el) chips.current.set(key, el);
                      else chips.current.delete(key);
                    }}
                    type="button"
                    data-seam-chip=""
                    onClick={() => setOpenKey(isOpen ? null : key)}
                    aria-label={`Seam at ${formatClockPrecise(seam.at)}, ${seconds} s removed`}
                    aria-haspopup="dialog"
                    aria-expanded={isOpen}
                    className={cn(
                      "pointer-events-auto flex items-center justify-center whitespace-nowrap transition-colors duration-fast",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus",
                      chip.kind === "label"
                        ? "rounded-full border px-1.5 font-sans text-xs leading-none tabular-nums shadow-xs"
                        : "rounded-sm",
                      chip.kind === "label" &&
                        (strong
                          ? "border-danger bg-danger text-surface"
                          : "border-danger/40 bg-surface text-danger hover:border-danger"),
                    )}
                    style={
                      chip.kind === "label"
                        ? { height: CHIP_HEIGHT }
                        : {
                            width: PIP_PX,
                            height: PIP_PX,
                            marginBottom: (CHIP_HEIGHT - PIP_PX) / 2,
                          }
                    }
                  >
                    {chip.kind === "label" ? (
                      label
                    ) : (
                      <span
                        className={cn(
                          "block h-2 w-2 rotate-45 bg-danger",
                          !strong && "opacity-70 hover:opacity-100",
                        )}
                      />
                    )}
                  </button>
                </Tooltip>
              </div>
            )}
          </div>
        );
      })}
      {open && openX != null && (
        <SeamPopover
          key={openKey}
          projectId={projectId}
          seam={open}
          left={popoverLeft}
          caretX={Math.min(
            Math.max(CARET_INSET_PX, openX - popoverLeft),
            SEAM_POPOVER_WIDTH - CARET_INSET_PX,
          )}
          bottom={CHIP_BOTTOM + openRow * CHIP_ROW_PX + CHIP_HEIGHT + POPOVER_GAP_PX}
          onClose={close}
        />
      )}
    </>
  );
}
