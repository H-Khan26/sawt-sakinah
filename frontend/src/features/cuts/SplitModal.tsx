/**
 * "New project from selection" dialog: carve the selected source-time range into a fresh,
 * independent project. Renders the range with edits inside it applied (server-side), imports
 * it as a new project, then navigates to that project's editor carrying the job id — so the
 * editor's normal extraction-style `useJob` poll shows the render+import progress.
 */
import { useSplitProject } from "@/api/hooks";
import { Alert, Button, Input, Modal } from "@/components/ui";
import { formatClock } from "@/lib/time";
import type { EditorLocationState } from "@/pages/EditorPage";
import type { ProjectView } from "@/types/api";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

export function SplitModal({
  project,
  range,
  onClose,
}: {
  project: ProjectView;
  range: { start: number; end: number };
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const split = useSplitProject(project.id);
  const rangeLabel = `${formatClock(range.start)}–${formatClock(range.end)}`;
  const [name, setName] = useState(`${project.name} (${rangeLabel})`);

  const submit = () => {
    split.mutate(
      {
        range_start: range.start,
        range_end: range.end,
        name: name.trim() || null,
      },
      {
        onSuccess: ({ project_id, job_id }) => {
          const state: EditorLocationState = { jobId: job_id };
          navigate(`/p/${project_id}`, { state });
        },
      },
    );
  };

  return (
    <Modal open onClose={onClose} ariaLabel="New project from selection">
      <div className="border-b border-border px-5 py-3 font-serif text-lg">
        New project from selection
      </div>

      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="rounded border border-border bg-background-secondary/40 px-3 py-2 text-sm text-text-secondary">
          A new project will be created from{" "}
          <span className="tabular-nums text-text">{rangeLabel}</span>{" "}
          <span className="text-text-tertiary">
            ({(range.end - range.start).toFixed(1)}s, edits inside applied)
          </span>
          .
        </div>

        <Input
          label="Project name"
          placeholder={project.name}
          value={name}
          disabled={split.isPending}
          onChange={(e) => setName(e.target.value)}
        />

        {split.isError && (
          <Alert variant="error" title="Couldn't create the project">
            {split.error.message}
          </Alert>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="secondary" onClick={onClose} disabled={split.isPending}>
          Cancel
        </Button>
        <Button onClick={submit} loading={split.isPending}>
          Create project
        </Button>
      </div>
    </Modal>
  );
}
