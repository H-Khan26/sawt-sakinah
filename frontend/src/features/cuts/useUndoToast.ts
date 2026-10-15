/**
 * A toast announcing a sweeping edit (remove all silence, keep only a surah) with an Undo button.
 * Undo reverts the edit only while it is still the latest one: undo and redo keep an edit's
 * snapshot id, so it is found again after either, and a later edit owns the top of the stack,
 * in which case the toast points to the transport row's Undo instead.
 */
import { useToast } from "@/components/ui";
import { type EditSnapshot, useEditStore } from "@/stores/editStore";
import { type ReactNode, useCallback, useRef } from "react";
import { useEdlEditor } from "./useEdlEditor";

/** How long an Undo toast stays up. */
const UNDO_TOAST_MS = 8000;

export function useUndoToast(projectId: string): (message: ReactNode, edit: EditSnapshot) => void {
  const { toast } = useToast();
  const editor = useEdlEditor(projectId);
  // The Undo runs after later renders; it reads the editor from a ref.
  const editorRef = useRef(editor);
  editorRef.current = editor;

  return useCallback(
    (message, edit) => {
      toast(message, "info", UNDO_TOAST_MS, {
        label: "Undo",
        onClick: () => {
          const { undoStack, redoStack } = useEditStore.getState();
          if (redoStack.at(-1)?.id === edit.id) return; // already undone
          if (undoStack.at(-1)?.id !== edit.id) {
            toast("Later edits came after this one. Use Undo in the transport row.", "warning");
            return;
          }
          editorRef.current.undo();
        },
      });
    },
    [toast],
  );
}
