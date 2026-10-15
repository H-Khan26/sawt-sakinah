/**
 * "New recording" dialog: copy source-time ranges into a fresh, independent recording. The
 * ranges are rendered back to back with the edits inside them applied (server-side) and
 * imported as a new recording; the dialog then navigates to its editor carrying the job id, so
 * the editor's normal extraction-style `useJob` poll shows the render+import progress.
 *
 * One range comes from the Cut tool's selection and is named by its times; several come from a
 * surah's passages, which the dialog sums up as the number of parts and their total length.
 */
import { useSplitProject } from "@/api/hooks";
import { Alert, Button, Input, Modal, ModalTitle } from "@/components/ui";
import { type Span, mergeSpans, spanTotal } from "@/lib/edl";
import { formatClock, formatHms } from "@/lib/time";
import type { EditorLocationState } from "@/pages/EditorPage";
import type { ProjectView } from "@/types/api";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

export function SplitModal({
  project,
  ranges,
  defaultName,
  title = "New recording from selection",
  onClose,
}: {
  project: ProjectView;
  /** Source-time ranges to copy, in any order; overlapping ones are joined. */
  ranges: Span[];
  /** The name the field starts with. */
  defaultName: string;
  title?: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const split = useSplitProject(project.id);
  const [name, setName] = useState(defaultName);
  const parts = mergeSpans(ranges);
  const total = spanTotal(parts);

  const submit = () => {
    split.mutate(
      { ranges: parts, name: name.trim() || null },
      {
        onSuccess: ({ project_id, job_id }) => {
          const state: EditorLocationState = { jobId: job_id };
          navigate(`/p/${project_id}`, { state });
        },
      },
    );
  };

  return (
    <Modal open onClose={onClose} ariaLabel={title}>
      <ModalTitle>{title}</ModalTitle>

      <div className="flex flex-col gap-4 px-5 py-4">
        <div className="rounded border border-border bg-background-secondary/40 px-3 py-2 text-sm text-text-secondary">
          {parts.length === 1 ? (
            <>
              A new recording will be created from{" "}
              <span className="tabular-nums text-text">
                {formatClock(parts[0][0])}–{formatClock(parts[0][1])}
              </span>{" "}
              <span className="text-text-tertiary">
                ({total.toFixed(1)}s, edits inside applied)
              </span>
              .
            </>
          ) : (
            <>
              A new recording will join{" "}
              <span className="tabular-nums text-text">{parts.length} parts</span>,{" "}
              <span className="tabular-nums text-text">{formatHms(total)}</span> in all{" "}
              <span className="text-text-tertiary">(edits inside applied)</span>. Everything between
              them is left out.
            </>
          )}
        </div>

        <Input
          label="Recording name"
          placeholder={project.name}
          value={name}
          disabled={split.isPending}
          onChange={(e) => setName(e.target.value)}
        />

        {split.isError && (
          <Alert variant="error" title="Couldn't create the recording">
            {split.error.message}
          </Alert>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="secondary" onClick={onClose} disabled={split.isPending}>
          Cancel
        </Button>
        <Button onClick={submit} loading={split.isPending} disabled={parts.length === 0}>
          Create recording
        </Button>
      </div>
    </Modal>
  );
}
