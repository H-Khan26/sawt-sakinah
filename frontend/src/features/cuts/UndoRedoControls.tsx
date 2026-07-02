/**
 * Global undo/redo arrows for the transport bar. They act on the shared EDL history in
 * `editStore`, so they undo/redo every kind of edit (silence removal/restore and manual cuts)
 * regardless of which panel made it. Ctrl/Cmd+Z / Shift+Z / Y do the same from the keyboard.
 */
import { Button } from "@/components/ui";
import { useEditStore } from "@/stores/editStore";
import type { EditOperation } from "@/types/api";
import { useEdlEditor } from "./useEdlEditor";

export function UndoRedoControls({
  projectId,
  ops,
}: {
  projectId: string;
  ops: EditOperation[];
}) {
  const editor = useEdlEditor(projectId);
  const undoDepth = useEditStore((s) => s.undoStack.length);
  const redoDepth = useEditStore((s) => s.redoStack.length);

  return (
    <div className="flex items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        disabled={undoDepth === 0 || editor.isPending}
        onClick={() => editor.undo(ops)}
        aria-label="Undo"
        title="Undo (Ctrl+Z)"
      >
        ↶
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={redoDepth === 0 || editor.isPending}
        onClick={() => editor.redo(ops)}
        aria-label="Redo"
        title="Redo (Ctrl+Shift+Z)"
      >
        ↷
      </Button>
    </div>
  );
}
