/**
 * Local editor state for silence + manual-cut editing: which rows/regions are selected, the
 * pending in/out selection range, and the undo/redo history of EDL edits.
 *
 * The *live* EDL (the current `operations[]`) is server state and lives in the React Query
 * project cache — never duplicated here. This store holds only what the server doesn't:
 * the transient selection and past/future snapshots for undo/redo. A snapshot is the whole
 * `operations[]` array captured just before an edit; `beginEdit`/`undo`/`redo` push and pop
 * those, and the caller applies the returned array via `usePutEdl`.
 *
 * `selectedIds` holds both silence keys (`start:end`, see `silenceKey`) and committed
 * manual-cut keys (`cut:start:end`, see `cutKey`); the two never collide, so a single set
 * drives selection for both the silence list and the cut list.
 */
import type { EditOperation } from "@/types/api";
import { create } from "zustand";

interface EditState {
  /** Selected silence keys and manual-cut keys (see `silenceKey` / `cutKey`). */
  selectedIds: Set<string>;
  /** Pending in-point of a manual cut range (source seconds), or null. Set by the `I` key. */
  selectionStart: number | null;
  /** Pending out-point of a manual cut range (source seconds), or null. Set by the `O` key. */
  selectionEnd: number | null;
  /** Past EDL snapshots (most recent last). */
  undoStack: EditOperation[][];
  /** Future EDL snapshots for redo (most recent last). */
  redoStack: EditOperation[][];

  toggleSelected: (id: string) => void;
  setSelected: (ids: string[]) => void;
  clearSelection: () => void;

  setSelectionStart: (t: number | null) => void;
  setSelectionEnd: (t: number | null) => void;
  setSelectionRange: (start: number | null, end: number | null) => void;
  clearSelectionRange: () => void;

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
  selectionStart: null,
  selectionEnd: null,
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

  setSelectionStart: (t) => set({ selectionStart: t }),
  setSelectionEnd: (t) => set({ selectionEnd: t }),
  setSelectionRange: (start, end) => set({ selectionStart: start, selectionEnd: end }),
  clearSelectionRange: () => set({ selectionStart: null, selectionEnd: null }),

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

  reset: () =>
    set({
      selectedIds: new Set<string>(),
      selectionStart: null,
      selectionEnd: null,
      undoStack: [],
      redoStack: [],
    }),
}));
