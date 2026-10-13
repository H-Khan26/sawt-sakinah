/**
 * The marker overlay: projects each `Marker` onto the waveform as a `MarkerChip`, absolutely
 * positioned by `time -> x` under the current zoom/scroll (see `useMarkerLayout`). Clicking a
 * chip selects it (for the editor) and seeks there. Markers are server state passed straight
 * through from the project cache — this layer holds none of its own.
 *
 * Notes that would run into the next one are reduced to their star, so a dense, zoomed-out view
 * stays legible. Rendered into `WaveformView`'s overlay slot, which is anchored to the same box
 * the waveform draws into so the x offsets line up with the audio.
 */
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { useMarkerStore } from "@/stores/markerStore";
import type { Marker, PrayerPosition } from "@/types/api";
import { useMemo } from "react";
import { MarkerChip } from "./MarkerChip";
import { markerNote } from "./names";
import { useMarkerLayout } from "./useMarkerLayout";

/** Keep chips whose line is just off-screen so a partly-visible label still renders. */
const OFFSCREEN_MARGIN = 48;
/** Rough width of a note: star and gap, plus an italic character at 14 px. */
const NOTE_BASE_PX = 22;
const NOTE_CHAR_PX = 6.6;
/** Space kept clear after a note before the next one may show. */
const NOTE_GAP_PX = 10;

export function MarkerLayer({
  markers,
  structure,
}: {
  markers: Marker[];
  structure: PrayerPosition[];
}) {
  const { controller, timeMap } = useWaveformContext();
  const layout = useMarkerLayout();
  const selectedId = useMarkerStore((s) => s.selectedMarkerId);
  const selectMarker = useMarkerStore((s) => s.selectMarker);

  const notes = useMemo(
    () => new Map(markers.map((m) => [m.id, markerNote(m, structure)])),
    [markers, structure],
  );

  if (!layout || layout.pxPerSec <= 0) return null;

  // Markers live on the source timeline; project onto the (possibly collapsed) edited timeline,
  // and drop any marker whose audio has been cut away.
  const placed = markers
    .filter((m) => !timeMap.isDeleted(m.time))
    .map((m) => ({ marker: m, x: timeMap.toEdited(m.time) * layout.pxPerSec - layout.scrollLeft }))
    .filter(({ x }) => x >= -OFFSCREEN_MARGIN && x <= layout.width + OFFSCREEN_MARGIN)
    .sort((a, b) => a.x - b.x);

  let clearFrom = Number.NEGATIVE_INFINITY;
  return (
    <>
      {placed.map(({ marker, x }) => {
        const note = notes.get(marker.id) ?? "";
        const showNote = x >= clearFrom;
        const width = NOTE_BASE_PX + (showNote ? note.length * NOTE_CHAR_PX : 0);
        clearFrom = Math.max(clearFrom, x + width + NOTE_GAP_PX);
        return (
          <MarkerChip
            key={marker.id}
            marker={marker}
            note={note}
            showNote={showNote}
            x={x}
            selected={marker.id === selectedId}
            onSelect={() => {
              selectMarker(marker.id);
              controller.setSourceTime(marker.time);
            }}
          />
        );
      })}
    </>
  );
}
