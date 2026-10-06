/**
 * Persisted editor preferences (local to the browser, shared across projects).
 *
 * `showDeleted` controls whether cut ("deleted") audio is visible on the waveform. The default is
 * off: the waveform collapses cut spans out so the view isn't polluted by removed audio (a live
 * preview of the export). Turning it on restores the full source timeline with cut regions
 * highlighted in place, for inspecting or restoring cuts.
 *
 * `silenceDetector` is the silence-detection mode last chosen in the silence panel. It is a
 * per-user preference rather than project data: the backend applies its own default when the
 * field is omitted, so the choice only needs to survive reloads on this browser.
 */
import type { SilenceDetector } from "@/types/api";
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ViewPrefsState {
  showDeleted: boolean;
  setShowDeleted: (v: boolean) => void;
  toggleShowDeleted: () => void;
  silenceDetector: SilenceDetector;
  setSilenceDetector: (v: SilenceDetector) => void;
}

export const useViewPrefs = create<ViewPrefsState>()(
  persist(
    (set) => ({
      showDeleted: false,
      setShowDeleted: (showDeleted) => set({ showDeleted }),
      toggleShowDeleted: () => set((s) => ({ showDeleted: !s.showDeleted })),
      silenceDetector: "vad",
      setSilenceDetector: (silenceDetector) => set({ silenceDetector }),
    }),
    { name: "sawt-view-prefs" },
  ),
);
