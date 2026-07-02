/**
 * One marker on the waveform: a vertical guide line plus a `Badge`-styled label chip,
 * colored by marker type. Low-confidence auto markers are dimmed and dashed so the user
 * knows which to verify. Purely presentational — positioning (`x`) and the click handler
 * come from `MarkerLayer`.
 */
import { Badge, badgeVariantForMarker } from "@/components/ui";
import { cn } from "@/lib/cn";
import { markerColors } from "@/lib/themeColors";
import type { Marker } from "@/types/api";

/** Auto markers below this confidence are shown as tentative. */
const LOW_CONFIDENCE = 0.5;

export function MarkerChip({
  marker,
  x,
  selected,
  onSelect,
}: {
  marker: Marker;
  /** Horizontal offset within the waveform viewport, in pixels. */
  x: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const variant = badgeVariantForMarker(marker.type);
  const tentative = marker.source === "auto" && marker.confidence < LOW_CONFIDENCE;

  return (
    <div className="absolute inset-y-0" style={{ left: `${x}px` }}>
      <div
        className="absolute inset-y-0 w-px -translate-x-1/2"
        style={{ backgroundColor: markerColors.line, opacity: tentative ? 0.4 : 0.85 }}
      />
      <button
        type="button"
        onClick={onSelect}
        aria-label={`Marker ${marker.label} at ${marker.time.toFixed(1)}s`}
        aria-pressed={selected}
        className={cn(
          "pointer-events-auto absolute top-1 -translate-x-1/2 rounded-full",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus",
          selected && "ring-2 ring-accent-secondary ring-offset-1 ring-offset-background-secondary",
        )}
        style={{ opacity: tentative ? 0.65 : 1 }}
      >
        <Badge
          variant={variant}
          className={cn(tentative && "border border-dashed border-white/70")}
        >
          <span lang="ar" dir="rtl" className="font-arabic">
            {marker.label}
          </span>
        </Badge>
      </button>
    </div>
  );
}
