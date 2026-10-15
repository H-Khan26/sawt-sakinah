/**
 * Local editor state for the surah view: the selected surah, and the surah-matching job running
 * for each project.
 *
 * The surah map itself is server state (the React Query project cache) and is never copied here.
 * The selection is transient: selecting a surah highlights all its passages in the band, the
 * tints and the list, and is cleared on project change or with Escape. The job ids are kept per
 * project, so leaving a recording mid-match and coming back picks up its progress again, and the
 * jobs whose success turned the Surah view on are remembered, so that happens once per job.
 */
import { create } from "zustand";

interface SurahState {
  /** Number of the selected surah, or null. */
  selected: number | null;
  select: (surah: number | null) => void;
  /** The surah-matching job last started per project id. */
  jobs: Record<string, string>;
  setJob: (projectId: string, jobId: string) => void;
  /** Forget a project's job (when the project is deleted). */
  clearJob: (projectId: string) => void;
  /** Jobs whose success has been announced (the Surah view turned on). */
  announced: Record<string, true>;
  markAnnounced: (jobId: string) => void;
  /** Clear the selection (on project change or leaving the editor). */
  reset: () => void;
}

export const useSurahStore = create<SurahState>((set) => ({
  selected: null,
  select: (selected) => set({ selected }),
  jobs: {},
  setJob: (projectId, jobId) => set((s) => ({ jobs: { ...s.jobs, [projectId]: jobId } })),
  clearJob: (projectId) =>
    set((s) => {
      const jobs = { ...s.jobs };
      delete jobs[projectId];
      return { jobs };
    }),
  announced: {},
  markAnnounced: (jobId) => set((s) => ({ announced: { ...s.announced, [jobId]: true } })),
  reset: () => set({ selected: null }),
}));
