/**
 * The detected-silence rows, compact and scrolling: index, span, duration, and a selection
 * checkbox. Clicking a row seeks to the span and adds it to the selection; the checkbox toggles
 * selection.
 * Selection lives in `editStore` and is reflected in both this list and the waveform.
 */
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/time";
import { useEditStore } from "@/stores/editStore";
import type { SilenceSegment } from "@/types/api";
import { silenceKey } from "./regions";

export function SilenceList({
  silences,
  removedIds,
}: {
  silences: SilenceSegment[];
  /** Keys of silences currently marked for removal (a `cut` op exists in the EDL). */
  removedIds: Set<string>;
}) {
  const { controller, timeMap } = useWaveformContext();
  const selectedIds = useEditStore((s) => s.selectedIds);
  const toggleSelected = useEditStore((s) => s.toggleSelected);

  if (silences.length === 0) return null;

  return (
    <ul className="max-h-48 divide-y divide-border overflow-y-auto border-y border-border">
      {silences.map((seg, i) => {
        const key = silenceKey(seg);
        const selected = selectedIds.has(key);
        const removed = removedIds.has(key);
        return (
          <li key={key} className="flex items-center gap-3 py-1.5 text-sm">
            <input
              type="checkbox"
              className="accent-accent h-4 w-4 cursor-pointer"
              checked={selected}
              onChange={() => toggleSelected(key)}
              aria-label={`Select silence ${i + 1}`}
            />
            <button
              type="button"
              className="flex flex-1 items-center justify-between gap-4 text-left"
              onClick={() => {
                if (!selected) toggleSelected(key);
                controller.setSourceTime(seg.start);
              }}
            >
              <span className="w-6 tabular-nums text-text-tertiary">{i + 1}</span>
              <span
                className={cn(
                  "flex-1 tabular-nums text-text-secondary",
                  removed && "text-text-tertiary line-through",
                )}
              >
                {formatClock(timeMap.toEdited(seg.start))} –{" "}
                {formatClock(timeMap.toEdited(seg.end))}
              </span>
              {removed && <span className="text-xs text-accent">removed</span>}
              <span className="tabular-nums text-text-tertiary">{seg.duration.toFixed(1)}s</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
