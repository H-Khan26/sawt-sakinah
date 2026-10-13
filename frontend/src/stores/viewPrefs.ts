/**
 * Editor preferences shared across projects, stored by the backend (`/app/preferences`).
 *
 * The desktop window's port, and so its origin, changes every launch, so browser storage would
 * forget these. The store holds the live values for synchronous reads; {@link loadViewPrefs}
 * hydrates it once from `GET /app/preferences`, and each setter applies its change locally first
 * and then PATCHes it, one request at a time. A failed load or save leaves the local value in
 * place, so the UI keeps working on defaults.
 *
 * `showDeleted` controls whether cut ("deleted") audio is visible on the waveform. The default is
 * off: the waveform collapses cut spans out so the view isn't polluted by removed audio (a live
 * preview of the export). Turning it on restores the full source timeline with cut regions
 * highlighted in place, for inspecting or restoring cuts.
 *
 * `silenceDetector` is the silence-detection mode last chosen in the silence panel.
 *
 * `theme` is the colour theme (`system` follows the OS; see `src/theme/theme.ts`), `landing`
 * whether the app opens under the dome, and `libraryView` the library's layout. `hydrated` turns
 * true once the stored values have loaded (or failed to), for choices that must not flash a default.
 */
import { patchPreferences, queryKeys } from "@/api/endpoints";
import { preferencesQuery } from "@/api/hooks";
import { queryClient } from "@/lib/queryClient";
import type {
  AppPreferences,
  LibraryView,
  PreferencesPatch,
  SilenceDetector,
  ThemePreference,
} from "@/types/api";
import { create } from "zustand";

interface ViewPrefsState {
  /** The stored values have loaded, or failed to load and the defaults stand. */
  hydrated: boolean;
  showDeleted: boolean;
  setShowDeleted: (v: boolean) => void;
  toggleShowDeleted: () => void;
  silenceDetector: SilenceDetector;
  setSilenceDetector: (v: SilenceDetector) => void;
  theme: ThemePreference;
  setTheme: (v: ThemePreference) => void;
  landing: boolean;
  setLanding: (v: boolean) => void;
  libraryView: LibraryView;
  setLibraryView: (v: LibraryView) => void;
}

const THEMES: readonly ThemePreference[] = ["system", "day", "night"];
const LIBRARY_VIEWS: readonly LibraryView[] = ["icons", "list"];

/** Keys the user changed before the initial load landed; hydration must not overwrite them. */
const touched = new Set<keyof PreferencesPatch>();
let loaded = false;

/** The latest queued save; each save waits for it, so the server applies them in order. */
let saving: Promise<void> = Promise.resolve();

/** PATCH a change and mirror the stored result into the preferences query cache. */
function save(patch: PreferencesPatch) {
  for (const key of Object.keys(patch) as (keyof PreferencesPatch)[]) touched.add(key);
  saving = saving
    .then(() => patchPreferences(patch))
    .then((prefs) => {
      queryClient.setQueryData(queryKeys.preferences, prefs);
    })
    .catch(() => {
      // Keep the local value; the preference just won't survive a restart.
    });
}

export const useViewPrefs = create<ViewPrefsState>()((set, get) => ({
  hydrated: false,
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
  theme: "system",
  setTheme: (theme) => {
    set({ theme });
    save({ theme });
  },
  landing: true,
  setLanding: (landing) => {
    set({ landing });
    save({ landing });
  },
  libraryView: "icons",
  setLibraryView: (libraryView) => {
    set({ libraryView });
    save({ library_view: libraryView });
  },
}));

function hydrate(prefs: AppPreferences) {
  if (loaded) return;
  loaded = true;
  const next: Partial<ViewPrefsState> = { hydrated: true };
  if (!touched.has("show_deleted")) next.showDeleted = prefs.show_deleted;
  if (
    !touched.has("silence_detector") &&
    (prefs.silence_detector === "vad" || prefs.silence_detector === "ffmpeg")
  ) {
    next.silenceDetector = prefs.silence_detector;
  }
  if (!touched.has("theme") && THEMES.includes(prefs.theme)) next.theme = prefs.theme;
  if (!touched.has("landing")) next.landing = prefs.landing;
  if (!touched.has("library_view") && LIBRARY_VIEWS.includes(prefs.library_view)) {
    next.libraryView = prefs.library_view;
  }
  useViewPrefs.setState(next);
}

/**
 * Load the stored preferences into {@link useViewPrefs} (and the preferences query cache). Call
 * once at startup, before the first render, so the request goes out with nothing ahead of it and
 * the landing decision waits only on it.
 */
export function loadViewPrefs(): void {
  queryClient.fetchQuery(preferencesQuery).then(hydrate, () => {
    useViewPrefs.setState({ hydrated: true });
  });
}
