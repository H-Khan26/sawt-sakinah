/**
 * The single choke point through which every EDL edit (silence removal/restore, cuts, keep-only,
 * undo, redo) flows, so all surfaces share one coherent undo history.
 *
 * The live ops are read from the project cache when an edit runs. `useSaveEdl` writes each edit
 * there at once and saves it in the background, so an edit always builds on the previous one,
 * even while saves are in flight. Applying an edit normalizes the result's cut ranges, records
 * the pre-edit ops with the edit's label as an undo point, and saves the result; undo/redo swap
 * snapshots and save the result.
 */
import { queryKeys } from "@/api/endpoints";
import { useSaveEdl } from "@/api/hooks";
import { type EditSnapshot, useEditStore } from "@/stores/editStore";
import type { EditOperation, ProjectView } from "@/types/api";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeCuts, sameOps } from "./cutEdl";

export interface EdlEditor {
  /**
   * Apply `edit` to the live ops and record it as an undo point named `label` (e.g. "Cut 4.2 s").
   * Returns the undo point, or null when the edit changes nothing.
   */
  apply: (edit: (ops: EditOperation[]) => EditOperation[], label: string) => EditSnapshot | null;
  /** Undo the last edit; no-op if the undo stack is empty. */
  undo: () => void;
  /** Redo the last undone edit; no-op if the redo stack is empty. */
  redo: () => void;
}

export function useEdlEditor(projectId: string): EdlEditor {
  const queryClient = useQueryClient();
  const save = useSaveEdl(projectId);
  const live = () => queryClient.getQueryData<ProjectView>(queryKeys.project(projectId));

  return {
    apply: (edit, label) => {
      const project = live();
      if (!project) return null;
      const current = project.edl.operations;
      const duration = project.audio_source.duration_sec;
      const next = normalizeCuts(edit(current), duration);
      if (sameOps(normalizeCuts(current, duration), next)) return null;
      const snapshot = { ops: current, label };
      useEditStore.getState().beginEdit(snapshot);
      save(next);
      return snapshot;
    },
    undo: () => {
      const project = live();
      const prev = project && useEditStore.getState().undo(project.edl.operations);
      if (prev) save(prev);
    },
    redo: () => {
      const project = live();
      const next = project && useEditStore.getState().redo(project.edl.operations);
      if (next) save(next);
    },
  };
}
