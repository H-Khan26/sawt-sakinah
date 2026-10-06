/**
 * Editor preferences shared across projects, stored by the backend (`/app/preferences`).
 *
 * The desktop window's port, and so its origin, changes every launch, so browser storage would
 * forget these. The store holds the live values for synchronous reads; {@link useSyncViewPrefs}
 * hydrates it once from `GET /app/preferences`, and each setter applies its change locally first
 * and then PATCHes it. A failed load or save leaves the local value in place, so the UI keeps
 * working on defaults.
 *
 * `showDeleted` controls whether cut ("deleted") audio is visible on the waveform. The default is
 * off: the waveform collapses cut spans out so the view isn't polluted by removed audio (a live
 * preview of the export). Turning it on restores the full source timeline with cut regions
 * highlighted in place, for inspecting or restoring cuts.
 *
 * `silenceDetector` is the silence-detection mode last chosen in the silence panel.
 */
import { patchPreferences, queryKeys } from "@/api/endpoints";
import { usePreferences } from "@/api/hooks";
import { queryClient } from "@/lib/queryClient";
import type { AppPreferences, PreferencesPatch, SilenceDetector } from "@/types/api";
import { useEffect } from "react";
import { create } from "zustand";

interface ViewPrefsState {
  showDeleted: boolean;
  setShowDeleted: (v: boolean) => void;
  toggleShowDeleted: () => void;
  silenceDetector: SilenceDetector;
  setSilenceDetector: (v: SilenceDetector) => void;
}

/** Keys the user changed before the initial load landed; hydration must not overwrite them. */
const touched = new Set<keyof PreferencesPatch>();
let hydrated = false;

/** PATCH a change and mirror the stored result into the preferences query cache. */
function save(patch: PreferencesPatch) {
  for (const key of Object.keys(patch) as (keyof PreferencesPatch)[]) touched.add(key);
  patchPreferences(patch)
    .then((prefs) => queryClient.setQueryData(queryKeys.preferences, prefs))
    .catch(() => {
      // Keep the local value; the preference just won't survive a restart.
    });
}

export const useViewPrefs = create<ViewPrefsState>()((set, get) => ({
  showDeleted: false,
  setShowDeleted: (showDeleted) => {
    set({ showDeleted });
    save({ show_deleted: showDeleted });
  },
  toggleShowDeleted: () => get().setShowDeleted(!get().showDeleted),
  silenceDetector: "vad",
  setSilenceDetector: (silenceDetector) => {
    set({ silenceDetector });
    save({ silence_detector: silenceDetector });
  },
}));

function hydrate(prefs: AppPreferences) {
  if (hydrated) return;
  hydrated = true;
  const next: Partial<ViewPrefsState> = {};
  if (!touched.has("show_deleted")) next.showDeleted = prefs.show_deleted;
  if (
    !touched.has("silence_detector") &&
    (prefs.silence_detector === "vad" || prefs.silence_detector === "ffmpeg")
  ) {
    next.silenceDetector = prefs.silence_detector;
  }
  useViewPrefs.setState(next);
}

/** Load the stored preferences into {@link useViewPrefs}. Mount once, near the app root. */
export function useSyncViewPrefs() {
  const { data } = usePreferences();
  useEffect(() => {
    if (data) hydrate(data);
  }, [data]);
}
