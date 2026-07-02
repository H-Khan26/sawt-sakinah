/**
 * Composes the marker feature: phrase-detection trigger, the add/edit affordances, and the
 * derived prayer outline. Mirrors `SilencePanel`. Markers and structure are read straight
 * from the project cache (server state); this panel owns only the selection reset on exit.
 */
import { PanelSection } from "@/components/ui";
import { useMarkerStore } from "@/stores/markerStore";
import type { ProjectView } from "@/types/api";
import { useEffect } from "react";
import { MarkerControls } from "./MarkerControls";
import { MarkerEditor } from "./MarkerEditor";
import { PrayerStructurePanel } from "./PrayerStructurePanel";

export function MarkersPanel({ project }: { project: ProjectView }) {
  const reset = useMarkerStore((s) => s.reset);

  // Clear the marker selection when leaving the editor.
  useEffect(() => () => reset(), [reset]);

  return (
    <PanelSection id="markers" title="Markers & prayer structure">
      <div className="flex flex-col gap-5">
        <MarkerControls projectId={project.id} hasMarkers={project.markers.length > 0} />
        <MarkerEditor project={project} />
        <PrayerStructurePanel markers={project.markers} structure={project.structure} />
      </div>
    </PanelSection>
  );
}
