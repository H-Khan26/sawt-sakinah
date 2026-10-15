import { silenceKey } from "@/features/silence/regions";
import { WAVE_HEIGHT } from "@/features/waveform/layout";
import type { TimeMap } from "@/features/waveform/timeMap";
/**
 * Reconciles *all* waveform overlays onto the single shared Regions plugin: detected-silence
 * spans, cut ranges, and the pending in/out selection. The regions are a pure
 * projection of app state, so we clear and re-add on every change (counts are modest), keying
 * each region id back to what it represents so a click can map to the right action:
 *
 * - silence  -> id `start:end`      (see `silenceKey`)
 * - cut      -> id `cut:start:end`  (a merged cut range; see `cutKey`)
 * - pending  -> id `selection`      (the not-yet-committed range)
 *
 * Silence is a flat band; cut audio (a cut range, or a removed silence while deleted audio is
 * shown) is a 45° hatch with an edge line at each end.
 */
import type { ThemeColors } from "@/lib/themeColors";
import type { SilenceSegment } from "@/types/api";
import type { Region } from "wavesurfer.js/plugins/regions";
import type RegionsPlugin from "wavesurfer.js/plugins/regions";
import { type Span, cutKey } from "./cutEdl";

/** Region id of the pending (uncommitted) in/out selection. */
export const SELECTION_REGION_ID = "selection";

export interface EditRegionsState {
  silences: SilenceSegment[];
  /** Keys of silences marked for removal (fully covered by a cut range). */
  removedIds: Set<string>;
  /** Merged cut ranges to hatch, excluding those that are exactly a removed silence. */
  cutSpans: Span[];
  /** Selected silence/cut keys (drives fill emphasis). */
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

/**
 * Draw a region as cut audio: the hatch stripes and edge lines are DOM styles, so they take the
 * tokens directly and follow a theme change on their own.
 */
function hatch(region: Region, selected: boolean): void {
  if (!region.element) return;
  const stripe = selected ? "var(--cut-stripe-selected)" : "var(--cut-stripe)";
  const style = region.element.style;
  style.backgroundImage = `repeating-linear-gradient(45deg, ${stripe} 0 2px, transparent 2px 7px)`;
  style.borderLeft = "1px solid var(--color-error)";
  style.borderRight = "1px solid var(--color-error)";
  style.boxSizing = "border-box";
}

/**
 * Clear and re-add every overlay region from the current app state. All state is authored in
 * source time; coordinates are projected onto the (possibly collapsed) edited timeline via
 * `timeMap`. In the collapsed view cut audio is gone from the timeline, so cut overlays are
 * omitted and any silence that collapses to zero width (e.g. a removed one) is skipped.
 */
export function reconcileEditRegions(regions: RegionsPlugin, state: EditRegionsState): void {
  const {
    silences,
    removedIds,
    cutSpans,
    selectedIds,
    selectionStart,
    selectionEnd,
    timeMap,
    colors,
  } = state;
  const { silenceColors, selectionColors } = colors;
  regions.clearRegions();

  for (const seg of silences) {
    const key = silenceKey(seg);
    const start = timeMap.toEdited(seg.start);
    const end = timeMap.toEdited(seg.end);
    if (end <= start) continue;
    const selected = selectedIds.has(key);
    const removed = removedIds.has(key);
    const region = fitToBars(
      regions.addRegion({
        id: key,
        start,
        end,
        drag: false,
        resize: false,
        color: removed ? "transparent" : selected ? silenceColors.fillSelected : silenceColors.fill,
      }),
    );
    if (removed) hatch(region, selected);
  }

  // Cut regions mark deleted audio in place — only meaningful when that audio is still on the
  // timeline (the show-deleted / identity view). Collapsed, there is nothing to mark.
  if (timeMap.identity) {
    for (const span of cutSpans) {
      const key = cutKey(span);
      const region = fitToBars(
        regions.addRegion({
          id: key,
          start: span[0],
          end: span[1],
          drag: false,
          resize: false,
          color: "transparent",
        }),
      );
      hatch(region, selectedIds.has(key));
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
