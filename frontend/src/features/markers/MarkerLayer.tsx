/**
 * The marker overlay: projects each `Marker` onto the waveform as a `MarkerChip`, absolutely
 * positioned by `time -> x` under the current zoom/scroll (see `useMarkerLayout`). Clicking a
 * chip selects it (for the editor) and seeks there. Markers are server state passed straight
 * through from the project cache — this layer holds none of its own.
 *
 * Rendered into `WaveformView`'s overlay slot, which is anchored to the same box the waveform
 * draws into so the x offsets line up with the audio.
 */
import { useWaveformContext } from "@/features/waveform/WaveformContext";
import { useMarkerStore } from "@/stores/markerStore";
import type { Marker } from "@/types/api";
import { MarkerChip } from "./MarkerChip";
import { useMarkerLayout } from "./useMarkerLayout";

/** Keep chips whose line is just off-screen so a partly-visible label still renders. */
const OFFSCREEN_MARGIN = 48;

export function MarkerLayer({ markers }: { markers: Marker[] }) {
  const { controller, timeMap } = useWaveformContext();
  const layout = useMarkerLayout();
  const selectedId = useMarkerStore((s) => s.selectedMarkerId);
  const selectMarker = useMarkerStore((s) => s.selectMarker);

  if (!layout || layout.pxPerSec <= 0) return null;

  return (
    <>
      {markers.map((m) => {
        // Markers live on the source timeline; project onto the (possibly collapsed) edited
        // timeline, and drop any marker whose audio has been cut away.
        if (timeMap.isDeleted(m.time)) return null;
        const x = timeMap.toEdited(m.time) * layout.pxPerSec - layout.scrollLeft;
        if (x < -OFFSCREEN_MARGIN || x > layout.width + OFFSCREEN_MARGIN) return null;
        return (
          <MarkerChip
            key={m.id}
            marker={m}
            x={x}
            selected={m.id === selectedId}
            onSelect={() => {
              selectMarker(m.id);
              controller.setSourceTime(m.time);
            }}
          />
        );
      })}
    </>
  );
}
