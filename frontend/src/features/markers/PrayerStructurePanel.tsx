/**
 * The derived prayer outline: positions grouped by rak'ah. Click a position to seek there;
 * the position containing the playhead highlights as audio plays. Structure is server state
 * (re-derived from the markers on every edit) — this panel only renders it and surfaces a
 * gentle notice when the outline looks incomplete (never a hard error; recitations vary).
 */
import { Alert } from "@/components/ui";
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { cn } from "@/lib/cn";
import { formatClock } from "@/lib/time";
import { usePlaybackStore } from "@/stores/playbackStore";
import type { Marker, PrayerPosition } from "@/types/api";
import { activePositionIndex } from "./structure";

/** Readable names for the position labels. */
const POSITION_DISPLAY: Record<string, string> = {
  qiyam: "Qiyam",
  ruku: "Ruku'",
  itidal: "I'tidal",
  sujood: "Sujood",
  julus: "Julus",
  tasleem: "Tasleem",
};
const positionDisplay = (name: string): string => POSITION_DISPLAY[name] ?? name;

/** A gentle, non-error notice when the derived outline looks incomplete. */
function structureNotice(markers: Marker[], structure: PrayerPosition[]): string | null {
  if (markers.length === 0) return null;
  if (structure.length <= 1) {
    return "No position changes were derived — check that the takbir markers were detected.";
  }
  if (!structure.some((p) => p.name === "tasleem")) {
    return "No closing tasleem detected; the final position runs to the end of the recording.";
  }
  return null;
}

/** Group positions into ordered rak'ah buckets, preserving their order. */
function groupByRakah(structure: PrayerPosition[]): [number, PrayerPosition[]][] {
  const groups = new Map<number, PrayerPosition[]>();
  for (const p of structure) {
    const bucket = groups.get(p.rakah);
    if (bucket) bucket.push(p);
    else groups.set(p.rakah, [p]);
  }
  return [...groups.entries()];
}

export function PrayerStructurePanel({
  markers,
  structure,
}: {
  markers: Marker[];
  structure: PrayerPosition[];
}) {
  const { wavesurfer } = useWaveformContext();
  // Selector returns the active index; zustand re-renders this panel only when it changes,
  // not on every per-frame time update.
  const activeIndex = usePlaybackStore((s) => activePositionIndex(structure, s.currentTime));

  if (structure.length === 0) {
    return (
      <p className="text-sm text-text-tertiary">
        Run phrase detection to build the prayer outline.
      </p>
    );
  }

  const notice = structureNotice(markers, structure);

  return (
    <div className="flex flex-col gap-3">
      {notice && (
        <Alert variant="warning" title="Check the outline">
          {notice}
        </Alert>
      )}
      <div className="flex flex-col gap-3">
        {groupByRakah(structure).map(([rakah, positions]) => (
          <div key={rakah} className="flex flex-col gap-1">
            <div className="text-xs font-medium uppercase tracking-wide text-text-tertiary">
              Rak'ah {rakah}
            </div>
            <ul className="flex flex-col">
              {positions.map((p) => {
                const active = p.index === activeIndex;
                return (
                  <li key={p.index}>
                    <button
                      type="button"
                      onClick={() => wavesurfer?.setTime(p.start)}
                      className={cn(
                        "flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-left text-sm transition-colors duration-fast",
                        active
                          ? "bg-accent-soft text-accent"
                          : "text-text-secondary hover:bg-background-tertiary",
                      )}
                    >
                      <span>{positionDisplay(p.name)}</span>
                      <span className="tabular-nums text-text-tertiary">
                        {formatClock(p.start)} – {p.end === null ? "end" : formatClock(p.end)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
