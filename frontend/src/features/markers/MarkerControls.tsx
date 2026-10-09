/**
 * Phrase-detection trigger: runs `POST /detect/phrases` (Whisper) and shows job progress.
 * Detection is slow and runs on a single-worker pool, so the poll can take a while — the
 * `JobProgress` `{ stage, status }` UI stays visible for the duration. Defaults are used
 * (no params UI in v1; the backend picks the model from the preferences); on success the
 * project is invalidated so the new markers refetch.
 *
 * Detection needs the selected speech model on disk. Until it is, the button is disabled and a
 * download prompt takes its place; a 409 `ModelNotInstalledError` (stale catalog) refetches the
 * catalog so the same prompt appears instead of a generic error.
 */
import { queryKeys } from "@/api/endpoints";
import { useDetectPhrases, useJob, useModels } from "@/api/hooks";
import { JobProgress } from "@/components/JobProgress";
import { Button } from "@/components/ui";
import { ModelDownloadPrompt } from "@/features/models/ModelDownload";
import { MODEL_NOT_INSTALLED, isModelNotInstalled } from "@/features/models/useModelDownload";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export function MarkerControls({
  projectId,
  hasMarkers,
}: {
  projectId: string;
  hasMarkers: boolean;
}) {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [serverMissingModel, setServerMissingModel] = useState(false);

  const models = useModels();
  const selected = models.data?.find((m) => m.selected);

  const detect = useDetectPhrases(projectId);
  const job = useJob(jobId, { invalidateProject: true });
  const running = job.data?.state === "pending" || job.data?.state === "running";
  const detecting = detect.isPending || running;
  const jobMissingModel =
    job.data?.state === "failed" && job.data.error_type === MODEL_NOT_INSTALLED;

  // A job that lost its model mid-flight means the cached catalog is stale.
  useEffect(() => {
    if (jobMissingModel) queryClient.invalidateQueries({ queryKey: queryKeys.models });
  }, [jobMissingModel, queryClient]);

  // The catalog is authoritative once loaded; without it, fall back to what the server said.
  const needsModel = selected
    ? !selected.installed
    : serverMissingModel || Boolean(jobMissingModel);

  const run = () => {
    detect.mutate(
      {},
      {
        onSuccess: (r) => setJobId(r.job_id),
        onError: (err) => {
          if (!isModelNotInstalled(err)) return;
          setServerMissingModel(true);
          queryClient.invalidateQueries({ queryKey: queryKeys.models });
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={run} loading={detecting} disabled={needsModel}>
          {hasMarkers ? "Re-detect phrases" : "Detect phrases"}
        </Button>
        {/* A missing-model failure is shown as the download prompt below instead. */}
        {job.data?.state === "failed" && !(jobMissingModel && needsModel) && (
          <span className="text-sm text-danger">Detection failed. Try again.</span>
        )}
        {detect.isError && !(isModelNotInstalled(detect.error) && needsModel) && (
          <span className="text-sm text-danger">{detect.error.message}</span>
        )}
      </div>
      {needsModel &&
        (selected ? (
          <ModelDownloadPrompt model={selected} />
        ) : (
          <p className="text-sm text-text-secondary">
            The speech model isn't downloaded yet. Download it from Settings (the gear in the
            header).
          </p>
        ))}
      {detecting && (
        <>
          <JobProgress job={job.data} />
          <p className="text-xs text-text-tertiary">
            Phrase detection transcribes the whole recitation on the CPU and can take several
            minutes.
          </p>
        </>
      )}
    </div>
  );
}
