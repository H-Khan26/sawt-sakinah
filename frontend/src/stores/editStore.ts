/**
 * Local editor state for silence + cut editing: which rows/regions are selected, the pending
 * in/out selection range, and the undo/redo history of EDL edits.
 *
 * The *live* EDL (the current `operations[]`) lives in the React Query project cache, where
 * edits land at once and are saved in the background — never duplicated here. This store holds
 * only what the server doesn't: the transient selection and past/future snapshots for undo/redo.
 * A snapshot is the whole `operations[]` array captured just before an edit, with a short label
 * naming the edit ("Cut 4.2 s"); `beginEdit`/`undo`/`redo` push and pop those, and the caller
 * applies the returned array through `useEdlEditor`.
 *
 * The state belongs to one editor session: the editor resets it when the project changes or the
 * editor closes (see `EditorPage`).
 *
 * `selectedIds` holds both silence keys (`start:end`, see `silenceKey`) and cut-range keys
 * (`cut:start:end`, see `cutKey`); the two never collide, so a single set drives selection for
 * the silence list and the waveform. Silences select many at a time; at most one cut range is
 * selected (`selectCut`), the one whose edges the waveform offers to drag.
 */
import { CUT_KEY_PREFIX } from "@/features/cuts/cutEdl";
import type { EditOperation } from "@/types/api";
import { create } from "zustand";

/** An undo/redo point: the ops to return to, and the label of the edit it reverts or replays. */
export interface EditSnapshot {
  ops: EditOperation[];
  label: string;
}

interface EditState {
  /** Selected silence keys and cut-range keys (see `silenceKey` / `cutKey`). */
  selectedIds: Set<string>;
  /** Pending in-point of a cut range (source seconds), or null. Set by the `I` key. */
  selectionStart: number | null;
  /** Pending out-point of a cut range (source seconds), or null. Set by the `O` key. */
  selectionEnd: number | null;
  /** Past EDL snapshots (most recent last). */
  undoStack: EditSnapshot[];
  /** Future EDL snapshots for redo (most recent last). */
  redoStack: EditSnapshot[];

  toggleSelected: (id: string) => void;
  setSelected: (ids: string[]) => void;
  clearSelection: () => void;
  /** Select the cut range `key` in place of any selected one; null deselects it. */
  selectCut: (key: string | null) => void;

  setSelectionStart: (t: number | null) => void;
  setSelectionEnd: (t: number | null) => void;
  setSelectionRange: (start: number | null, end: number | null) => void;
  clearSelectionRange: () => void;

  /** Record `snapshot` (the pre-edit ops) as an undo point before applying an edit; clears redo. */
  beginEdit: (snapshot: EditSnapshot) => void;
  /** Pop an undo snapshot; pushes `current` onto redo. Returns ops to apply, or null. */
  undo: (current: EditOperation[]) => EditOperation[] | null;
  /** Pop a redo snapshot; pushes `current` onto undo. Returns ops to apply, or null. */
  redo: (current: EditOperation[]) => EditOperation[] | null;

  /** Clear selection + history (on project change or leaving the editor). */
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
  selectCut: (key) =>
    set((s) => {
      const current = [...s.selectedIds].find((id) => id.startsWith(CUT_KEY_PREFIX)) ?? null;
      if (current === key) return s;
      const next = new Set(s.selectedIds);
      if (current) next.delete(current);
      if (key) next.add(key);
      return { selectedIds: next };
    }),

  setSelectionStart: (t) => set({ selectionStart: t }),
  setSelectionEnd: (t) => set({ selectionEnd: t }),
  setSelectionRange: (start, end) => set({ selectionStart: start, selectionEnd: end }),
  clearSelectionRange: () => set({ selectionStart: null, selectionEnd: null }),

  beginEdit: (snapshot) => set((s) => ({ undoStack: [...s.undoStack, snapshot], redoStack: [] })),

  undo: (current) => {
    const { undoStack, redoStack } = get();
    const prev = undoStack.at(-1);
    if (!prev) return null;
    set({
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, { ops: current, label: prev.label }],
    });
    return prev.ops;
  },

  redo: (current) => {
    const { undoStack, redoStack } = get();
    const next = redoStack.at(-1);
    if (!next) return null;
    set({
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, { ops: current, label: next.label }],
    });
    return next.ops;
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
