/**
 * Persisted editor view preferences (local to the browser, shared across projects).
 *
 * `showDeleted` controls whether cut ("deleted") audio is visible on the waveform. The default is
 * off: the waveform collapses cut spans out so the view isn't polluted by removed audio (a live
 * preview of the export). Turning it on restores the full source timeline with cut regions
 * highlighted in place, for inspecting or restoring cuts.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ViewPrefsState {
  showDeleted: boolean;
  setShowDeleted: (v: boolean) => void;
  toggleShowDeleted: () => void;
}

export const useViewPrefs = create<ViewPrefsState>()(
  persist(
    (set) => ({
      showDeleted: false,
      setShowDeleted: (showDeleted) => set({ showDeleted }),
      toggleShowDeleted: () => set((s) => ({ showDeleted: !s.showDeleted })),
    }),
    { name: "sawt-view-prefs" },
  ),
);
