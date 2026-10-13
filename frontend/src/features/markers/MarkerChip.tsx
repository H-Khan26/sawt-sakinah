/**
 * One marker on the waveform, set like a note in a manuscript margin: a small green star and
 * the note (`Takbīr · sujood`) in Ibarra italic above the top rule, with the guide line running
 * down through the bars. The Arabic label is the tooltip and part of the accessible name. The
 * selected marker's note takes the accent and an underline; low-confidence auto markers are
 * dimmed so the user knows which to verify. A shown note sits above its neighbours' stars, on the
 * page ground. Positioning (`x`) and the click handler come from `MarkerLayer`.
 */
import { RubElHizb } from "@/components/ornament";
import { NOTES_HEIGHT } from "@/features/waveform/layout";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/time";
import type { Marker } from "@/types/api";

/** Auto markers below this confidence are shown as tentative. */
const LOW_CONFIDENCE = 0.5;

export function MarkerChip({
  marker,
  note,
  showNote,
  x,
  selected,
  onSelect,
}: {
  marker: Marker;
  /** The marginal note text (see `markerNote`). */
  note: string;
  /** Whether there is room for the note; otherwise only the star shows. */
  showNote: boolean;
  /** Horizontal offset within the waveform viewport, in pixels. */
  x: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const tentative = marker.source === "auto" && marker.confidence < LOW_CONFIDENCE;

  return (
    <div className={cn("absolute inset-y-0", showNote && "z-10")} style={{ left: `${x}px` }}>
      <div
        className="absolute bottom-0 w-px -translate-x-1/2 bg-[color:var(--marker-line)]"
        style={{ top: NOTES_HEIGHT, opacity: tentative ? 0.4 : 0.85 }}
      />
      <button
        type="button"
        onClick={onSelect}
        title={marker.label}
        aria-label={`${note}, ${marker.label}, at ${formatClock(marker.time)}`}
        aria-pressed={selected}
        className={cn(
          "pointer-events-auto absolute top-1.5 flex -translate-x-[5px] items-center gap-1.5 whitespace-nowrap rounded-sm pr-1 font-display text-sm italic leading-none",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus",
          selected ? "text-accent underline decoration-1 underline-offset-4" : "text-green",
          tentative && "opacity-50",
        )}
        style={{ height: NOTES_HEIGHT - 12 }}
      >
        <RubElHizb size={10} className="note" />
        {showNote && <span className="bg-surface pr-1">{note}</span>}
      </button>
    </div>
  );
}
