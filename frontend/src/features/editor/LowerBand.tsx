/**
 * The page's lower band, under a gold rule: the tools (Silence, Cut, Markers under ribbon tabs)
 * take 60% and the prayer outline 40%, split by a hairline. Each column scrolls on its own when
 * the page is fixed to the window. The tool panels stay mounted across tab switches so their
 * detection jobs, slider values and shortcuts survive. Phrase detection is shared by the Markers
 * tool and the outline.
 */
import { Tabs } from "@/components/ui";
import { CutPanel } from "@/features/cuts/CutPanel";
import { usePhraseDetection } from "@/features/markers/MarkerControls";
import { MarkersPanel } from "@/features/markers/MarkersPanel";
import { PrayerStructurePanel } from "@/features/markers/PrayerStructurePanel";
import { SilencePanel } from "@/features/silence/SilencePanel";
import type { ProjectView } from "@/types/api";

export function LowerBand({ project }: { project: ProjectView }) {
  const detection = usePhraseDetection(project.id);
  const tools = [
    { id: "silence", label: "Silence", content: <SilencePanel project={project} /> },
    { id: "cut", label: "Cut", content: <CutPanel project={project} /> },
    {
      id: "markers",
      label: "Markers",
      content: <MarkersPanel project={project} detection={detection} />,
    },
  ];

  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,3fr)_minmax(0,2fr)] border-t border-gold">
      <section aria-label="Tools" className="min-h-0 overflow-y-auto pb-2 pr-8">
        <Tabs items={tools} variant="ribbon" keepMounted panelClassName="pt-5" />
      </section>
      <section
        aria-label="Prayer outline"
        className="min-h-0 overflow-y-auto border-l border-border pb-2 pl-8 pt-5"
      >
        <PrayerStructurePanel markers={project.markers} structure={project.structure} />
      </section>
    </div>
  );
}
