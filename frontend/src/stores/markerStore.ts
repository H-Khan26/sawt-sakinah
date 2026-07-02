/**
 * Local editor state for the marker layer: which marker is currently selected.
 *
 * The markers themselves are server state (the React Query project cache, patched by
 * `useUpdateMarkers`) and are never duplicated here — this store holds only the transient
 * selection that drives the editor and the highlighted chip on the waveform. The derived
 * prayer structure is likewise server state; the *active* position is computed per-frame
 * from the playhead (see features/markers/structure.ts), not stored.
 */
import { create } from "zustand";

interface MarkerState {
  /** Id of the selected marker, or null. */
  selectedMarkerId: string | null;

  selectMarker: (id: string | null) => void;
  /** Clear the selection (on project change or leaving the editor). */
  reset: () => void;
}

export const useMarkerStore = create<MarkerState>((set) => ({
  selectedMarkerId: null,
  selectMarker: (selectedMarkerId) => set({ selectedMarkerId }),
  reset: () => set({ selectedMarkerId: null }),
}));
