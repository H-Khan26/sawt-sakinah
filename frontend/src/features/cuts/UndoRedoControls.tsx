/**
 * Global undo/redo for the transport row. They act on the shared EDL history in `editStore`, so
 * they undo/redo every kind of edit (silence removal/restore and manual cuts) regardless of which
 * tool made it. Ctrl/Cmd+Z / Shift+Z / Y do the same from the keyboard.
 */
import { Button, Tooltip } from "@/components/ui";
import { useEditStore } from "@/stores/editStore";
import type { EditOperation } from "@/types/api";
import { Redo2, Undo2 } from "lucide-react";
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
      <Tooltip content="Undo (Ctrl+Z)">
        <Button
          size="icon"
          variant="ghost"
          disabled={undoDepth === 0 || editor.isPending}
          onClick={() => editor.undo(ops)}
          aria-label="Undo"
        >
          <Undo2 size={18} />
        </Button>
      </Tooltip>
      <Tooltip content="Redo (Ctrl+Shift+Z)">
        <Button
          size="icon"
          variant="ghost"
          disabled={redoDepth === 0 || editor.isPending}
          onClick={() => editor.redo(ops)}
          aria-label="Redo"
        >
          <Redo2 size={18} />
        </Button>
      </Tooltip>
    </div>
  );
}
