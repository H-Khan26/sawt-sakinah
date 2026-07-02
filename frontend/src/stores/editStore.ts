/**
 * Local editor state for silence editing: which silence rows are selected and the
 * undo/redo history of EDL edits.
 *
 * The *live* EDL (the current `operations[]`) is server state and lives in the React Query
 * project cache — never duplicated here. This store holds only what the server doesn't:
 * the transient selection and past/future snapshots for undo/redo. A snapshot is the whole
 * `operations[]` array captured just before an edit; `beginEdit`/`undo`/`redo` push and pop
 * those, and the caller applies the returned array via `usePutEdl`.
 */
import type { EditOperation } from "@/types/api";
import { create } from "zustand";

interface EditState {
  /** Selected silence keys (see `silenceKey` in features/silence/regions.ts). */
  selectedIds: Set<string>;
  /** Past EDL snapshots (most recent last). */
  undoStack: EditOperation[][];
  /** Future EDL snapshots for redo (most recent last). */
  redoStack: EditOperation[][];

  toggleSelected: (id: string) => void;
  setSelected: (ids: string[]) => void;
  clearSelection: () => void;

  /** Record `current` as an undo point before applying a fresh edit; clears redo. */
  beginEdit: (current: EditOperation[]) => void;
  /** Pop an undo snapshot; pushes `current` onto redo. Returns ops to apply, or null. */
  undo: (current: EditOperation[]) => EditOperation[] | null;
  /** Pop a redo snapshot; pushes `current` onto undo. Returns ops to apply, or null. */
  redo: (current: EditOperation[]) => EditOperation[] | null;

  /** Clear selection + history (on project change or fresh detection). */
  reset: () => void;
}

export const useEditStore = create<EditState>((set, get) => ({
  selectedIds: new Set<string>(),
  undoStack: [],
  redoStack: [],

  toggleSelected: (id) =>
    set((s) => {
      const next = new Set(s.selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedIds: next };
    }),
  setSelected: (ids) => set({ selectedIds: new Set(ids) }),
  clearSelection: () => set({ selectedIds: new Set<string>() }),

  beginEdit: (current) => set((s) => ({ undoStack: [...s.undoStack, current], redoStack: [] })),

  undo: (current) => {
    const { undoStack, redoStack } = get();
    if (undoStack.length === 0) return null;
    const prev = undoStack[undoStack.length - 1];
    set({
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, current],
    });
    return prev;
  },

  redo: (current) => {
    const { undoStack, redoStack } = get();
    if (redoStack.length === 0) return null;
    const next = redoStack[redoStack.length - 1];
    set({
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, current],
    });
    return next;
  },

  reset: () => set({ selectedIds: new Set<string>(), undoStack: [], redoStack: [] }),
}));
