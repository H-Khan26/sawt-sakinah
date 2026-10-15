/**
 * The Silence tool: detection controls, a summary of what was found, the bulk actions, and the
 * detected-silence list.
 *
 * The live EDL lives in the project cache (edits land there at once, see `useSaveEdl`); this
 * component reads `project.edl.operations` straight from props and never copies them into a
 * store. Edits route through `useEdlEditor`, so they share one undo history with the cut tool
 * and the undo/redo buttons in the transport row. "Remove all silence" applies at once (cuts are
 * hatched on the waveform and non-destructive) and offers Undo in a toast. Detected silences
 * stay in the list after removal, marked "removed", so they can be restored, while the range
 * covering them is pure silence removal; one that a content cut took is hidden (see
 * `silenceView`). Region drawing is owned by `useEditRegions` (mounted once in the editor), not
 * here.
 */
import { Button } from "@/components/ui";
import { useCutModel } from "@/features/cuts/cutModel";
import { useEdlEditor } from "@/features/cuts/useEdlEditor";
import { useUndoToast } from "@/features/cuts/useUndoToast";
import { formatClock } from "@/lib/time";
import { useEditStore } from "@/stores/editStore";
import type { ProjectView, SilenceSegment } from "@/types/api";
import { AlertTriangle } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { SilenceControls, useSilenceDetection } from "./SilenceControls";
import { SilenceList } from "./SilenceList";
import { removeSilences, restoreSilences, silenceStats } from "./edl";
import { silenceKey } from "./regions";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Whether two detected-silence lists hold the same spans. */
const sameSpans = (a: SilenceSegment[], b: SilenceSegment[]) =>
  a.length === b.length && a.every((s, i) => s.start === b[i].start && s.end === b[i].end);

export function SilencePanel({ project }: { project: ProjectView }) {
  const projectId = project.id;
  const silences = project.silences;

  const editor = useEdlEditor(projectId);
  const undoToast = useUndoToast(projectId);
  const detection = useSilenceDetection({
    projectId,
    hasDetected: silences.length > 0,
    hasSpeechMap: project.audio_source.has_speech_map,
  });

  const selectedIds = useEditStore((s) => s.selectedIds);
  const clearSelection = useEditStore((s) => s.clearSelection);

  // Fresh detection replaces the silence set, so selected silence keys go stale: clear the
  // selection. A refetch hands over an equal list, which keeps it. The undo history stays — its
  // snapshots are EDL ops, which don't reference silences.
  const lastSilences = useRef(silences);
  useEffect(() => {
    if (sameSpans(lastSilences.current, silences)) return;
    lastSilences.current = silences;
    clearSelection();
  }, [silences, clearSelection]);

  // Detected silences clipped to the audio content cuts left: silences (or parts of them)
  // inside deleted recitation drop out of the list, stats, and actions — regardless of whether
  // the cut was made before or after detection. Those silence removal took stay, as removed.
  const { active, removed: removedIds, kept } = useCutModel(project);

  const selected = useMemo(() => {
    const segs = active.filter((s) => selectedIds.has(silenceKey(s)));
    return {
      count: segs.length,
      removed: segs.filter((s) => removedIds.has(silenceKey(s))),
      kept: segs.filter((s) => !removedIds.has(silenceKey(s))),
    };
  }, [active, removedIds, selectedIds]);

  const detected = silenceStats(active);
  // "Already cut" counts the removed silences — other cuts live in the Cut tool.
  const removedCount = removedIds.size;
  const remaining = kept.length;

  // Each action edits only the selected silences it changes, and its label counts those.
  const removeSelected = () => {
    const segs = selected.kept;
    editor.apply(
      (o) => removeSilences(o, segs),
      `Remove ${plural(segs.length, "silence", "silences")}`,
    );
    clearSelection();
  };
  const restoreSelected = () => {
    const segs = selected.removed;
    editor.apply(
      (o) => restoreSilences(o, segs),
      `Restore ${plural(segs.length, "silence", "silences")}`,
    );
    clearSelection();
  };
  const removeAll = () => {
    const removal = editor.apply(
      (o) => removeSilences(o, kept),
      `Remove ${plural(remaining, "silence", "silences")}`,
    );
    clearSelection();
    if (removal) undoToast(`Removed ${plural(remaining, "silence", "silences")}.`, removal);
  };

  const hasSelection = selected.count > 0;

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
          <Button onClick={removeAll} disabled={remaining === 0}>
            Remove all silence
          </Button>
        </div>
      </div>

      {(detection.failed || detection.fellBack || detection.showFirstRunHint) && (
        <div className="flex flex-col gap-1 text-sm">
          {detection.failed && <span className="text-danger">Detection failed. Try again.</span>}
          {detection.fellBack && (
            <span className="flex items-start gap-1.5 text-text-secondary">
              <AlertTriangle
                size={14}
                aria-hidden="true"
                className="mt-[3px] shrink-0 text-warning"
              />
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
            {plural(selected.count, "silence", "silences")} selected
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={removeSelected}
            disabled={selected.kept.length === 0}
          >
            Remove selected
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={restoreSelected}
            disabled={selected.removed.length === 0}
          >
            Restore selected
          </Button>
        </div>
      )}

      <SilenceList silences={active} removedIds={removedIds} />
    </div>
  );
}
