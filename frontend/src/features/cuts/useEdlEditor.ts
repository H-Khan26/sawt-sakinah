/**
 * The single choke point through which every EDL edit (silence removal/restore, manual cuts,
 * undo, redo) flows, so all surfaces share one coherent undo history.
 *
 * Callers pass the *current* `operations[]` (server state from the project cache) into each
 * action so the snapshot pushed onto the undo stack is always the live one — the hook holds no
 * copy of its own. Applying an edit records the pre-edit ops as an undo point and persists the
 * next array via `usePutEdl`; undo/redo swap snapshots and persist the result.
 */
import { usePutEdl } from "@/api/hooks";
import { useEditStore } from "@/stores/editStore";
import type { EditOperation } from "@/types/api";

/** Shallow structural equality for op arrays — skips no-op persists. */
function sameOps(a: EditOperation[], b: EditOperation[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((op, i) => {
    const o = b[i];
    return op.type === o.type && op.start === o.start && op.end === o.end;
  });
}

export interface EdlEditor {
  /** Record `current` as an undo point and persist `next` (unless it's identical to `current`). */
  applyOps: (current: EditOperation[], next: EditOperation[]) => void;
  /** Undo the last edit given the `current` ops; no-op if the undo stack is empty. */
  undo: (current: EditOperation[]) => void;
  /** Redo the last undone edit given the `current` ops; no-op if the redo stack is empty. */
  redo: (current: EditOperation[]) => void;
  /** A persist is in flight. */
  isPending: boolean;
}

export function useEdlEditor(projectId: string): EdlEditor {
  const putEdl = usePutEdl(projectId);
  const beginEdit = useEditStore((s) => s.beginEdit);
  const undoStore = useEditStore((s) => s.undo);
  const redoStore = useEditStore((s) => s.redo);

  return {
    applyOps: (current, next) => {
      if (sameOps(current, next)) return;
      beginEdit(current);
      putEdl.mutate(next);
    },
    undo: (current) => {
      const prev = undoStore(current);
      if (prev) putEdl.mutate(prev);
    },
    redo: (current) => {
      const next = redoStore(current);
      if (next) putEdl.mutate(next);
    },
    isPending: putEdl.isPending,
  };
}
