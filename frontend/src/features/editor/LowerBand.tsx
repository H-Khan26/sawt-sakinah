/**
 * The page's lower band, under a gold rule: the Cut tool takes 60% and the Surahs column 40%,
 * split by a hairline. Each column scrolls on its own when the page is fixed to the window. The
 * Silence tool (`SilencePanel`) is not shown for now; see `SILENCE_TOOL` for its waveform layer.
 */
import { CutPanel } from "@/features/cuts/CutPanel";
import { SurahsPanel } from "@/features/surahs/SurahsPanel";
import type { ProjectView } from "@/types/api";

export function LowerBand({ project }: { project: ProjectView }) {
  return (
    <div className="grid min-h-0 grid-cols-[minmax(0,3fr)_minmax(0,2fr)] border-t border-gold">
      <section aria-label="Cut" className="min-h-0 overflow-y-auto pb-2 pr-8 pt-5">
        <CutPanel project={project} />
      </section>
      <section
        aria-label="Surahs"
        className="min-h-0 overflow-y-auto border-l border-border pb-2 pl-8 pt-5"
      >
        {/* Keyed by project: its request error and model answer belong to one recording. */}
        <SurahsPanel key={project.id} project={project} />
      </section>
    </div>
  );
}
