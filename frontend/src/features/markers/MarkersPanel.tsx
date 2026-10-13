/**
 * The Markers tool: phrase detection and the add/edit affordances. The prayer outline derived
 * from the markers lives beside the tools (see `PrayerOutline`). Markers are read straight from
 * the project cache (server state); this tool owns only the selection reset on exit.
 */
import { useMarkerStore } from "@/stores/markerStore";
import type { ProjectView } from "@/types/api";
import { useEffect } from "react";
import { MarkerControls, type PhraseDetection } from "./MarkerControls";
import { MarkerEditor } from "./MarkerEditor";

export function MarkersPanel({
  project,
  detection,
}: {
  project: ProjectView;
  detection: PhraseDetection;
}) {
  const reset = useMarkerStore((s) => s.reset);

  // Clear the marker selection when leaving the editor.
  useEffect(() => () => reset(), [reset]);

  return (
    <div className="flex flex-col gap-5">
      <MarkerControls detection={detection} />
      <MarkerEditor project={project} />
    </div>
  );
}
