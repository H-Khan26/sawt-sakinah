import { silenceKey } from "@/features/silence/regions";
import { WAVE_HEIGHT } from "@/features/waveform/layout";
import type { TimeMap } from "@/features/waveform/timeMap";
/**
 * Reconciles *all* waveform overlays onto the single shared Regions plugin: kept silences, cut
 * ranges, and the pending in/out selection. The regions are a pure projection of app state, so
 * we clear and re-add on every change (counts are modest), keying each region id back to what it
 * represents:
 *
 * - silence  -> id `start:end`      (see `silenceKey`)
 * - cut      -> id `cut:start:end`  (a merged cut range; see `cutKey`)
 * - pending  -> id `selection`      (the not-yet-committed range)
 *
 * A kept silence is a flat band. Removed audio is drawn from the merged cut ranges alone, one
 * region per range whether it came from silence removal or a marked cut, and only while deleted
 * audio is shown: the bars beneath dimmed, a 45° hatch, an edge line at each end, and a solid
 * bar along the bottom. The selected cut range has stronger stripes and a grip on each edge
 * (wavesurfer's resize handles) to drag that edge in (restore) or out (cut more).
 *
 * Silence and cut regions let pointer events through, so a drag that starts on them still paints
 * a selection; `useEditRegions` maps clicks on them from the waveform's own click. Only the
 * selection region and the selected cut's grips take the pointer.
 */
import type { Span } from "@/lib/edl";
import type { ThemeColors } from "@/lib/themeColors";
import type { SilenceSegment } from "@/types/api";
import type { Region } from "wavesurfer.js/plugins/regions";
import type RegionsPlugin from "wavesurfer.js/plugins/regions";
import { cutKey } from "./cutEdl";

/** Region id of the pending (uncommitted) in/out selection. */
export const SELECTION_REGION_ID = "selection";

/** Height (px) of the solid bar along the bottom of a cut range. */
const CUT_BAR_PX = 4;
/** Width (px) of a cut edge's grab area, centred on the edge. */
const GRIP_HIT_PX = 12;

export interface EditRegionsState {
  /** Detected silences still in the recitation and not removed (drawn as flat bands). */
  silences: SilenceSegment[];
  /** The merged cut ranges (source time); drawn only while deleted audio is shown. */
  cutSpans: Span[];
  /** Selected silence/cut keys (drives fill emphasis, and the cut range with grips). */
  selectedIds: Set<string>;
  /** Pending in/out points (source time); a region is drawn only when both are set and span > 0. */
  selectionStart: number | null;
  selectionEnd: number | null;
  /** Source -> edited mapping. Region ids stay in source keys; coordinates are projected. */
  timeMap: TimeMap;
  /** The theme's region colours. */
  colors: ThemeColors;
}

/** Keep a region between the waveform's rules, clear of the time ruler beneath. */
function fitToBars(region: Region): Region {
  if (region.element) region.element.style.height = `${WAVE_HEIGHT}px`;
  return region;
}

/** Let pointer events through a region to the waveform beneath. */
function passThrough(region: Region): Region {
  if (region.element) region.element.style.pointerEvents = "none";
  return region;
}

/**
 * Turn the resize handles of a cut region into grips: a wider grab area centred on each edge
 * with a small bar on it. They take the pointer although the region itself lets it through.
 */
function addGrips(el: HTMLElement): void {
  for (const handle of el.querySelectorAll<HTMLElement>('[part~="region-handle"]')) {
    const side = handle.getAttribute("part")?.includes("region-handle-left") ? "left" : "right";
    Object.assign(handle.style, {
      [side]: `${-GRIP_HIT_PX / 2}px`,
      width: `${GRIP_HIT_PX}px`,
      border: "none",
      borderRadius: "0",
      pointerEvents: "auto",
    });
    const grip = document.createElement("div");
    Object.assign(grip.style, {
      position: "absolute",
      top: "50%",
      left: "50%",
      width: "6px",
      height: "30px",
      transform: "translate(-50%, -50%)",
      borderRadius: "3px",
      background: "var(--color-error)",
      boxShadow: "0 0 0 1.5px var(--color-surface)",
      pointerEvents: "none",
    });
    handle.appendChild(grip);
  }
}

/**
 * Draw a region as removed audio. The dim, hatch, edges and bar are DOM styles, so they take the
 * tokens directly and follow a theme change on their own.
 */
function markCut(region: Region, selected: boolean): void {
  const el = region.element;
  if (!el) return;
  const stripe = selected ? "var(--cut-stripe-selected)" : "var(--cut-stripe)";
  const edge = `${selected ? 2 : 1}px solid var(--color-error)`;
  Object.assign(el.style, {
    backgroundImage: `repeating-linear-gradient(45deg, ${stripe} 0 2px, transparent 2px 7px)`,
    borderLeft: edge,
    borderRight: edge,
    borderRadius: "0",
    boxShadow: `inset 0 -${CUT_BAR_PX}px 0 var(--color-error)`,
  });
  if (selected) addGrips(el);
}

/**
 * Clear and re-add every overlay region from the current app state. All state is authored in
 * source time; coordinates are projected onto the (possibly collapsed) edited timeline via
 * `timeMap`. In the collapsed view cut audio is gone from the timeline, so cut overlays are
 * omitted and any silence that collapses to zero width is skipped.
 */
export function reconcileEditRegions(regions: RegionsPlugin, state: EditRegionsState): void {
  const { silences, cutSpans, selectedIds, selectionStart, selectionEnd, timeMap, colors } = state;
  const { silenceColors, selectionColors } = colors;
  regions.clearRegions();

  for (const seg of silences) {
    const key = silenceKey(seg);
    const start = timeMap.toEdited(seg.start);
    const end = timeMap.toEdited(seg.end);
    if (end <= start) continue;
    passThrough(
      fitToBars(
        regions.addRegion({
          id: key,
          start,
          end,
          drag: false,
          resize: false,
          color: selectedIds.has(key) ? silenceColors.fillSelected : silenceColors.fill,
        }),
      ),
    );
  }

  // Cut regions mark deleted audio in place — only meaningful when that audio is still on the
  // timeline (the show-deleted / identity view). Collapsed, there is nothing to mark.
  if (timeMap.identity) {
    for (const span of cutSpans) {
      const key = cutKey(span);
      const selected = selectedIds.has(key);
      // Only the selected range's edges resize; `region-updated` commits the drag (see
      // useEditRegions), and the redraw that follows replaces this region.
      const region = passThrough(
        fitToBars(
          regions.addRegion({
            id: key,
            start: span[0],
            end: span[1],
            drag: false,
            resize: selected,
            color: "var(--cut-dim)",
          }),
        ),
      );
      markCut(region, selected);
    }
  }

  if (selectionStart != null && selectionEnd != null) {
    const a = timeMap.toEdited(Math.min(selectionStart, selectionEnd));
    const b = timeMap.toEdited(Math.max(selectionStart, selectionEnd));
    if (b > a) {
      // The selection is the one interactive region: drag its body to move it, its edges to
      // fine-tune. `region-updated` writes the new bounds back to the store (see useEditRegions).
      fitToBars(
        regions.addRegion({
          id: SELECTION_REGION_ID,
          start: a,
          end: b,
          drag: true,
          resize: true,
          color: selectionColors.fill,
        }),
      );
    }
  }
}
