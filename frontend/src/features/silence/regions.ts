/**
 * Silence overlays are a *projection* of app state onto wavesurfer regions, not their own
 * source of truth. We reconcile by clearing and re-adding on every change (silence counts
 * are modest), keying the region id to the silence so a click maps back to its segment.
 */
import { silenceColors } from "@/lib/themeColors";
import type { SilenceSegment } from "@/types/api";
import type RegionsPlugin from "wavesurfer.js/plugins/regions";

/** Stable identity for a silence segment — the backend segments carry no id of their own. */
export const silenceKey = (seg: SilenceSegment): string => `${seg.start}:${seg.end}`;

/** Clear and re-add one read-only region per silence, colored by selection. */
export function reconcileRegions(
  regions: RegionsPlugin,
  silences: SilenceSegment[],
  selectedIds: Set<string>,
): void {
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
}
