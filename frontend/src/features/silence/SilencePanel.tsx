/**
 * Silence editing panel: detection controls, the detected-silence list, and the
 * non-destructive remove/restore actions.
 *
 * The live EDL is server state (the project cache, patched by `usePutEdl`); this component
 * reads `project.edl.operations` straight from props and never copies them into a store.
 * Edits route through `useEdlEditor`, so they share one undo history with the cut panel and
 * the global undo/redo arrows in the transport bar. Detected silences stay in the list after
 * removal, marked "removed", so a cut can be restored. Region drawing is owned by
 * `useEditRegions` (mounted once in the editor), not here.
 */
import { Button, PanelSection, SimpleModal } from "@/components/ui";
import { useEdlEditor } from "@/features/cuts/useEdlEditor";
import { useEditStore } from "@/stores/editStore";
import type { ProjectView } from "@/types/api";
import { useEffect, useMemo, useState } from "react";
import { SilenceControls } from "./SilenceControls";
import { SilenceList } from "./SilenceList";
import { activeSilences } from "./active";
import { addCuts, removeCuts, silenceStats } from "./edl";
import { silenceKey } from "./regions";

export function SilencePanel({ project }: { project: ProjectView }) {
  const projectId = project.id;
  const silences = project.silences;
  const ops = project.edl.operations;

  const editor = useEdlEditor(projectId);

  const selectedIds = useEditStore((s) => s.selectedIds);
  const clearSelection = useEditStore((s) => s.clearSelection);
  const reset = useEditStore((s) => s.reset);

  // Fresh detection replaces the silence set: drop stale selection + history. Keyed on the
  // silences identity, which changes only on (re)detection — EDL edits preserve it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional silences-only key
  useEffect(() => {
    reset();
  }, [silences]);
  // Clear on unmount (leaving the editor).
  useEffect(() => () => reset(), [reset]);

  const [confirmOpen, setConfirmOpen] = useState(false);

  // Detected silences clipped to the audio still active after manual cuts: silences (or parts of
  // them) inside deleted regions drop out of the list, stats, and actions — regardless of whether
  // the cut was made before or after detection.
  const active = useMemo(() => activeSilences(silences, ops), [silences, ops]);

  const selectedSegs = useMemo(
    () => active.filter((s) => selectedIds.has(silenceKey(s))),
    [active, selectedIds],
  );
  const removedIds = useMemo(
    () => new Set(ops.filter((o) => o.type === "cut").map((o) => `${o.start}:${o.end}`)),
    [ops],
  );

  const detected = silenceStats(active);
  // "Removed" here means detected silences marked for cut — manual cuts are tallied in CutPanel.
  const removed = silenceStats(active.filter((s) => removedIds.has(silenceKey(s))));

  const removeSelected = () => {
    editor.applyOps(ops, addCuts(ops, selectedSegs));
    clearSelection();
  };
  const restoreSelected = () => {
    editor.applyOps(ops, removeCuts(ops, selectedSegs));
    clearSelection();
  };
  const removeAll = () => {
    editor.applyOps(ops, addCuts(ops, active));
    clearSelection();
    setConfirmOpen(false);
  };

  const hasSelection = selectedSegs.length > 0;
  const busy = editor.isPending;

  return (
    <PanelSection id="silence" title="Silence">
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
        </div>

        <SilenceList silences={active} removedIds={removedIds} />
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
    </PanelSection>
  );
}
