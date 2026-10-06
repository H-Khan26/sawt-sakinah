/**
 * Download state for one speech model. The job id comes from the catalog (`download_job_id`),
 * so a download started before a reload, or from another panel, is picked up and polled here.
 * When the job settles the catalog refetches, which flips `installed` on success.
 */
import { ApiError } from "@/api/client";
import { queryKeys } from "@/api/endpoints";
import { useDownloadModel, useJob } from "@/api/hooks";
import type { SpeechModel } from "@/types/api";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/** Backend error type for phrase detection without the selected model on disk. */
export const MODEL_NOT_INSTALLED = "ModelNotInstalledError";

export function isModelNotInstalled(error: unknown): boolean {
  return error instanceof ApiError && error.type === MODEL_NOT_INSTALLED;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export interface ModelDownloadState {
  start: () => void;
  /** Requested, running, or finished and waiting for the catalog to report it installed. */
  active: boolean;
  failed: boolean;
  error: string | null;
  bytesDone: number | null;
  bytesTotal: number | null;
  /** 0..1 once the total size is known; null while it isn't. */
  fraction: number | null;
}

export function useModelDownload(model: SpeechModel | undefined): ModelDownloadState {
  const queryClient = useQueryClient();
  const download = useDownloadModel();
  const jobId = model && !model.installed ? (model.download_job_id ?? undefined) : undefined;
  const job = useJob(jobId);
  const state = job.data?.state;

  useEffect(() => {
    if (jobId && (state === "succeeded" || state === "failed")) {
      queryClient.invalidateQueries({ queryKey: queryKeys.models });
    }
  }, [jobId, state, queryClient]);

  const progress = job.data?.progress ?? {};
  const bytesDone = num(progress.bytes_done);
  const bytesTotal = num(progress.bytes_total);
  const fraction =
    bytesDone !== null && bytesTotal !== null && bytesTotal > 0 ? bytesDone / bytesTotal : null;

  const failed = !download.isPending && (download.isError || state === "failed");
  const error = download.isError
    ? download.error.message
    : state === "failed"
      ? (job.data?.error ?? "The download stopped unexpectedly.")
      : null;

  return {
    start: () => {
      if (model) download.mutate(model.id);
    },
    // A job poll that errors (e.g. the job is gone) reads as idle so the Download button returns.
    active: download.isPending || (jobId !== undefined && !job.isError && state !== "failed"),
    failed,
    error,
    bytesDone,
    bytesTotal,
    fraction,
  };
}
