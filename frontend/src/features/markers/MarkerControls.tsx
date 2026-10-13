/**
 * Phrase detection: runs `POST /detect/phrases` (Whisper) and tracks the job. Detection is slow
 * and runs on a single-worker pool, so the poll can take a while. Defaults are used (no params
 * UI in v1; the backend picks the model from the preferences); on success the project is
 * invalidated so the new markers refetch.
 *
 * Detection needs the selected speech model on disk. Until it is, the trigger is disabled and a
 * download prompt takes its place; a 409 `ModelNotInstalledError` (stale catalog) refetches the
 * catalog so the same prompt appears instead of a generic error.
 *
 * `usePhraseDetection` is called once per editor and shared by the Markers tool
 * (`MarkerControls`: button, progress, errors, model prompt) and the outline's button.
 */
import { queryKeys } from "@/api/endpoints";
import { useDetectPhrases, useJob, useModels } from "@/api/hooks";
import { JobProgress } from "@/components/JobProgress";
import { Button } from "@/components/ui";
import type { ButtonVariant } from "@/components/ui";
import { ModelDownloadPrompt } from "@/features/models/ModelDownload";
import { MODEL_NOT_INSTALLED, isModelNotInstalled } from "@/features/models/useModelDownload";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

export type PhraseDetection = ReturnType<typeof usePhraseDetection>;

export function usePhraseDetection(projectId: string) {
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

  // A missing-model failure is shown as the download prompt instead of an error line.
  const jobError = job.data?.state === "failed" && !(jobMissingModel && needsModel);
  const requestError =
    detect.isError && !(isModelNotInstalled(detect.error) && needsModel)
      ? detect.error.message
      : null;

  return {
    run,
    detecting,
    needsModel,
    selectedModel: selected,
    job: job.data,
    jobError,
    requestError,
  };
}

/** The detect button, shared by the Markers tool and the outline. */
export function DetectPhrasesButton({
  detection,
  variant = "secondary",
}: {
  detection: PhraseDetection;
  variant?: ButtonVariant;
}) {
  return (
    <Button
      variant={variant}
      onClick={detection.run}
      loading={detection.detecting}
      disabled={detection.needsModel}
    >
      Detect phrases
    </Button>
  );
}

/** The Markers tool's detection block: trigger, errors, model prompt and job progress. */
export function MarkerControls({ detection }: { detection: PhraseDetection }) {
  const d = detection;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <DetectPhrasesButton detection={d} variant="primary" />
        {d.jobError && <span className="text-sm text-danger">Detection failed. Try again.</span>}
        {d.requestError && <span className="text-sm text-danger">{d.requestError}</span>}
      </div>
      {d.needsModel &&
        (d.selectedModel ? (
          <ModelDownloadPrompt model={d.selectedModel} />
        ) : (
          <p className="text-sm text-text-secondary">
            The speech model isn't downloaded yet. Download it from Settings (the sliders icon at
            the foot of the rail).
          </p>
        ))}
      {d.detecting && (
        <>
          <JobProgress job={d.job} />
          <p className="text-xs text-text-tertiary">
            Phrase detection transcribes the whole recitation on the CPU and can take several
            minutes.
          </p>
        </>
      )}
    </div>
  );
}
