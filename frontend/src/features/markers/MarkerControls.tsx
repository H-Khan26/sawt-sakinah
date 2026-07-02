/**
 * Phrase-detection trigger: runs `POST /detect/phrases` (Whisper) and shows job progress.
 * Detection is slow and runs on a single-worker pool, so the poll can take a while — the
 * `JobProgress` `{ stage, status }` UI stays visible for the duration. Defaults are used
 * (no params UI in v1); on success the project is invalidated so the new markers refetch.
 */
import { useDetectPhrases, useJob } from "@/api/hooks";
import { JobProgress } from "@/components/JobProgress";
import { Button } from "@/components/ui";
import { useState } from "react";

export function MarkerControls({
  projectId,
  hasMarkers,
}: {
  projectId: string;
  hasMarkers: boolean;
}) {
  const [jobId, setJobId] = useState<string | undefined>(undefined);

  const detect = useDetectPhrases(projectId);
  const job = useJob(jobId, { invalidateProject: true });
  const running = job.data?.state === "pending" || job.data?.state === "running";
  const detecting = detect.isPending || running;

  const run = () => {
    detect.mutate({}, { onSuccess: (r) => setJobId(r.job_id) });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={run} loading={detecting}>
          {hasMarkers ? "Re-detect phrases" : "Detect phrases"}
        </Button>
        {job.data?.state === "failed" && (
          <span className="text-sm text-danger">Detection failed. Try again.</span>
        )}
      </div>
      {detecting && (
        <>
          <JobProgress job={job.data} />
          <p className="text-xs text-text-tertiary">
            Phrase detection transcribes the whole recitation and can take several minutes.
          </p>
        </>
      )}
    </div>
  );
}
