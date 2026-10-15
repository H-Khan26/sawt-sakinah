/**
 * Global undo/redo for the transport row. They act on the shared EDL history in `editStore`, so
 * they undo/redo every kind of edit (silence removal/restore and cuts) regardless of which tool
 * made it; the tooltips name the edit ("Undo cut 4.2 s"). Ctrl/Cmd+Z / Shift+Z / Y do the same
 * from the keyboard.
 */
import { Button, Tooltip } from "@/components/ui";
import { useEditStore } from "@/stores/editStore";
import { Redo2, Undo2 } from "lucide-react";
import { useEdlEditor } from "./useEdlEditor";

/** "Undo" plus the edit's label in lower case ("Undo cut 4.2 s"), or just the verb. */
const withLabel = (verb: string, label: string | undefined) =>
  label ? `${verb} ${label.charAt(0).toLowerCase()}${label.slice(1)}` : verb;

export function UndoRedoControls({ projectId }: { projectId: string }) {
  const editor = useEdlEditor(projectId);
  const undoLabel = useEditStore((s) => s.undoStack.at(-1)?.label);
  const redoLabel = useEditStore((s) => s.redoStack.at(-1)?.label);
  const canUndo = useEditStore((s) => s.undoStack.length > 0);
  const canRedo = useEditStore((s) => s.redoStack.length > 0);

  return (
    <div className="flex items-center gap-1">
      <Tooltip content={`${withLabel("Undo", undoLabel)} (Ctrl+Z)`}>
        <Button
          size="icon"
          variant="ghost"
          disabled={!canUndo}
          onClick={editor.undo}
          aria-label={withLabel("Undo", undoLabel)}
        >
          <Undo2 size={18} />
        </Button>
      </Tooltip>
      <Tooltip content={`${withLabel("Redo", redoLabel)} (Ctrl+Shift+Z)`}>
        <Button
          size="icon"
          variant="ghost"
          disabled={!canRedo}
          onClick={editor.redo}
          aria-label={withLabel("Redo", redoLabel)}
        >
          <Redo2 size={18} />
        </Button>
      </Tooltip>
    </div>
  );
}
