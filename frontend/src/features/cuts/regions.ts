import { silenceKey } from "@/features/silence/regions";
/**
 * Reconciles *all* waveform overlays onto the single shared Regions plugin: detected-silence
 * spans, committed manual cuts, and the pending in/out selection. The regions are a pure
 * projection of app state, so we clear and re-add on every change (counts are modest), keying
 * each region id back to what it represents so a click can map to the right action:
 *
 * - silence  -> id `start:end`      (see `silenceKey`)
 * - cut      -> id `cut:start:end`  (see `cutKey`)
 * - pending  -> id `selection`      (the not-yet-committed range)
 */
import { cutColors, selectionColors, silenceColors } from "@/lib/themeColors";
import type { EditOperation, SilenceSegment } from "@/types/api";
import type RegionsPlugin from "wavesurfer.js/plugins/regions";
import { cutKey } from "./cutEdl";

/** Region id of the pending (uncommitted) in/out selection. */
export const SELECTION_REGION_ID = "selection";

export interface EditRegionsState {
  silences: SilenceSegment[];
  /** Committed manual-cut ops (already filtered to exclude detected-silence cuts). */
  manualCuts: EditOperation[];
  /** Selected silence/cut keys (drives fill emphasis). */
  selectedIds: Set<string>;
  /** Pending in/out points; a region is drawn only when both are set and span > 0. */
  selectionStart: number | null;
  selectionEnd: number | null;
}

/** Clear and re-add every overlay region from the current app state. */
export function reconcileEditRegions(regions: RegionsPlugin, state: EditRegionsState): void {
  const { silences, manualCuts, selectedIds, selectionStart, selectionEnd } = state;
  regions.clearRegions();

  for (const seg of silences) {
    const key = silenceKey(seg);
    regions.addRegion({
      id: key,
      start: seg.start,
      end: seg.end,
      drag: false,
      resize: false,
      color: selectedIds.has(key) ? silenceColors.fillSelected : silenceColors.fill,
    });
  }

  for (const op of manualCuts) {
    const key = cutKey(op);
    regions.addRegion({
      id: key,
      start: op.start,
      end: op.end ?? op.start,
      drag: false,
      resize: false,
      color: selectedIds.has(key) ? cutColors.fillSelected : cutColors.fill,
    });
  }

  if (selectionStart != null && selectionEnd != null) {
    const a = Math.min(selectionStart, selectionEnd);
    const b = Math.max(selectionStart, selectionEnd);
    if (b > a) {
      regions.addRegion({
        id: SELECTION_REGION_ID,
        start: a,
        end: b,
        drag: false,
        resize: false,
        color: selectionColors.fill,
      });
    }
  }
}
