/**
 * The Silence tool: detection controls, a summary of what was found, the bulk actions, and the
 * detected-silence list.
 *
 * The live EDL is server state (the project cache, patched by `usePutEdl`); this component
 * reads `project.edl.operations` straight from props and never copies them into a store.
 * Edits route through `useEdlEditor`, so they share one undo history with the cut tool and
 * the undo/redo buttons in the transport row. "Remove all silence" applies at once (cuts are
 * hatched on the waveform and non-destructive) and offers Undo in a toast. Detected silences
 * stay in the list after removal, marked "removed", so a cut can be restored. Region drawing is
 * owned by `useEditRegions` (mounted once in the editor), not here.
 */
import { Button, useToast } from "@/components/ui";
import { cutSpanKeys } from "@/features/cuts/cutEdl";
import { useEdlEditor } from "@/features/cuts/useEdlEditor";
import { formatClock } from "@/lib/time";
import { useEditStore } from "@/stores/editStore";
import type { ProjectView } from "@/types/api";
import { useEffect, useMemo, useRef } from "react";
import { SilenceControls, useSilenceDetection } from "./SilenceControls";
import { SilenceList } from "./SilenceList";
import { activeSilences } from "./active";
import { addCuts, removeCuts, silenceStats } from "./edl";
import { silenceKey } from "./regions";

/** How long the Undo toast stays up after "Remove all silence". */
const UNDO_TOAST_MS = 8000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function SilencePanel({ project }: { project: ProjectView }) {
  const projectId = project.id;
  const silences = project.silences;
  const ops = project.edl.operations;

  const editor = useEdlEditor(projectId);
  const { toast } = useToast();
  const detection = useSilenceDetection({
    projectId,
    hasDetected: silences.length > 0,
    hasSpeechMap: project.audio_source.has_speech_map,
  });

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

  // The toast's Undo runs after later renders; it reads the live ops and editor from refs.
  const opsRef = useRef(ops);
  opsRef.current = ops;
  const editorRef = useRef(editor);
  editorRef.current = editor;

  // Detected silences clipped to the audio still active after manual cuts: silences (or parts of
  // them) inside deleted regions drop out of the list, stats, and actions — regardless of whether
  // the cut was made before or after detection.
  const active = useMemo(() => activeSilences(silences, ops), [silences, ops]);

  const selectedSegs = useMemo(
    () => active.filter((s) => selectedIds.has(silenceKey(s))),
    [active, selectedIds],
  );
  const removedIds = useMemo(() => cutSpanKeys(ops), [ops]);

  const detected = silenceStats(active);
  // "Already cut" counts detected silences marked for cut — manual cuts live in the Cut tool.
  const removedCount = active.filter((s) => removedIds.has(silenceKey(s))).length;
  const remaining = detected.count - removedCount;

  const removeSelected = () => {
    editor.applyOps(ops, addCuts(ops, selectedSegs));
    clearSelection();
  };
  const restoreSelected = () => {
    editor.applyOps(ops, removeCuts(ops, selectedSegs));
    clearSelection();
  };
  const removeAll = () => {
    const before = ops;
    editor.applyOps(before, addCuts(before, active));
    clearSelection();
    toast(`Removed ${plural(remaining, "silence", "silences")}.`, "info", UNDO_TOAST_MS, {
      label: "Undo",
      onClick: () => {
        // The live ops only reflect the removal once its save lands; undoing before that would
        // race the save and lose the redo step.
        if (editorRef.current.isPending) {
          toast("Still saving the removal. Use Undo in the transport row in a moment.", "warning");
          return;
        }
        // Undo only while this removal is still the latest edit; a later edit owns the stack top.
        if (useEditStore.getState().undoStack.at(-1) !== before) {
          toast("Later edits came after this removal. Use Undo in the transport row.", "warning");
          return;
        }
        editorRef.current.undo(opsRef.current);
      },
    });
  };

  const hasSelection = selectedSegs.length > 0;
  const busy = editor.isPending;

  return (
    <div className="flex flex-col gap-4">
      <SilenceControls detection={detection} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-dotted border-border pt-4">
        <p className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 text-sm text-text-secondary">
          {silences.length === 0 ? (
            <span>No silence detected yet.</span>
          ) : (
            <>
              <span className="font-display text-xl text-text">
                {plural(detected.count, "silence", "silences")}
              </span>
              <span className="whitespace-nowrap">
                {formatClock(detected.totalDuration)} in total · {removedCount} already cut
              </span>
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={detection.detectNow} loading={detection.detecting}>
            {silences.length > 0 ? "Detect again" : "Detect silence"}
          </Button>
          <Button onClick={removeAll} disabled={remaining === 0 || busy}>
            Remove all silence
          </Button>
        </div>
      </div>

      {(detection.failed || detection.fellBack || detection.showFirstRunHint) && (
        <div className="flex flex-col gap-1 text-sm">
          {detection.failed && <span className="text-danger">Detection failed. Try again.</span>}
          {detection.fellBack && (
            <span className="text-warning">
              Voice activity detection is unavailable on this server; the energy detector was used
              instead. Switch to Energy to tune the dB threshold.
            </span>
          )}
          {detection.showFirstRunHint && (
            <span className="text-xs text-text-secondary">
              The first run analyses speech for this recording.
            </span>
          )}
        </div>
      )}

      {hasSelection && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-sm text-text-secondary">
            {plural(selectedSegs.length, "silence", "silences")} selected
          </span>
          <Button size="sm" variant="secondary" onClick={removeSelected} disabled={busy}>
            Remove selected
          </Button>
          <Button size="sm" variant="secondary" onClick={restoreSelected} disabled={busy}>
            Restore selected
          </Button>
        </div>
      )}

      <SilenceList silences={active} removedIds={removedIds} />
    </div>
  );
}
