/**
 * Silence editing panel: detection controls, the detected-silence list, and the
 * non-destructive remove/restore actions with client-side undo/redo.
 *
 * The live EDL is server state (the project cache, patched by `usePutEdl`); this component
 * reads `project.edl.operations` straight from props and never copies them into a store.
 * `editStore` holds only the selection and undo/redo snapshots. Detected silences stay in
 * the list after removal, marked "removed", so a cut can be restored.
 */
import { usePutEdl } from "@/api/hooks";
import { Button, Card, SimpleModal } from "@/components/ui";
import { useEditStore } from "@/stores/editStore";
import type { EditOperation, ProjectView } from "@/types/api";
import { useEffect, useMemo, useState } from "react";
import { SilenceControls } from "./SilenceControls";
import { SilenceList } from "./SilenceList";
import { addCuts, cutStats, removeCuts, silenceStats } from "./edl";
import { silenceKey } from "./regions";
import { useSilenceRegions } from "./useSilenceRegions";

export function SilencePanel({ project }: { project: ProjectView }) {
  const projectId = project.id;
  const silences = project.silences;
  const ops = project.edl.operations;

  const putEdl = usePutEdl(projectId);

  const selectedIds = useEditStore((s) => s.selectedIds);
  const clearSelection = useEditStore((s) => s.clearSelection);
  const beginEdit = useEditStore((s) => s.beginEdit);
  const undo = useEditStore((s) => s.undo);
  const redo = useEditStore((s) => s.redo);
  const reset = useEditStore((s) => s.reset);
  const undoDepth = useEditStore((s) => s.undoStack.length);
  const redoDepth = useEditStore((s) => s.redoStack.length);

  useSilenceRegions(silences);

  // Fresh detection replaces the silence set: drop stale selection + history. Keyed on the
  // silences identity, which changes only on (re)detection — EDL edits preserve it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional silences-only key
  useEffect(() => {
    reset();
  }, [silences]);
  // Clear on unmount (leaving the editor).
  useEffect(() => () => reset(), [reset]);

  const [confirmOpen, setConfirmOpen] = useState(false);

  const selectedSegs = useMemo(
    () => silences.filter((s) => selectedIds.has(silenceKey(s))),
    [silences, selectedIds],
  );
  const removedIds = useMemo(
    () => new Set(ops.filter((o) => o.type === "cut").map((o) => `${o.start}:${o.end}`)),
    [ops],
  );

  const detected = silenceStats(silences);
  const removed = cutStats(ops);

  // Only persist when the op list actually changed. Our edits only add or remove `cut`
  // ops, so a length change reliably signals a real edit.
  const applyOps = (next: EditOperation[]) => {
    if (next.length === ops.length) return;
    beginEdit(ops);
    putEdl.mutate(next);
  };

  const removeSelected = () => {
    applyOps(addCuts(ops, selectedSegs));
    clearSelection();
  };
  const restoreSelected = () => {
    applyOps(removeCuts(ops, selectedSegs));
    clearSelection();
  };
  const removeAll = () => {
    applyOps(addCuts(ops, silences));
    clearSelection();
    setConfirmOpen(false);
  };
  const onUndo = () => {
    const prev = undo(ops);
    if (prev) putEdl.mutate(prev);
  };
  const onRedo = () => {
    const next = redo(ops);
    if (next) putEdl.mutate(next);
  };

  const hasSelection = selectedSegs.length > 0;
  const busy = putEdl.isPending;

  return (
    <Card header="Silence">
      <div className="flex flex-col gap-4">
        <SilenceControls projectId={projectId} hasDetected={silences.length > 0} />

        <div className="flex items-center justify-between text-sm text-text-secondary">
          <span>
            Detected <span className="tabular-nums text-text">{detected.count}</span> ·{" "}
            <span className="tabular-nums">{detected.totalDuration.toFixed(1)}s</span>
          </span>
          <span>
            Removed <span className="tabular-nums text-text">{removed.count}</span> ·{" "}
            <span className="tabular-nums">{removed.totalDuration.toFixed(1)}s</span>
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={removeSelected} disabled={!hasSelection || busy}>
            Remove selected
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={restoreSelected}
            disabled={!hasSelection || busy}
          >
            Restore selected
          </Button>
          <Button
            size="sm"
            variant="danger"
            onClick={() => setConfirmOpen(true)}
            disabled={detected.count === 0 || busy}
          >
            Remove all
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={onUndo} disabled={undoDepth === 0}>
              Undo
            </Button>
            <Button size="sm" variant="ghost" onClick={onRedo} disabled={redoDepth === 0}>
              Redo
            </Button>
          </div>
        </div>

        <SilenceList silences={silences} removedIds={removedIds} />
      </div>

      <SimpleModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Remove all detected silence?"
        confirm={{ label: "Remove all", variant: "danger", onClick: removeAll }}
      >
        This marks all {detected.count} detected silences for removal. You can undo this or restore
        individual gaps afterward. Nothing is changed until you export.
      </SimpleModal>
    </Card>
  );
}
