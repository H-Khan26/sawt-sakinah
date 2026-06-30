import type {
  CreateProjectRequest,
  EditOperation,
  ExportRequest,
  PhraseRequest,
  ProjectView,
  SilenceParams,
} from "@/types/api";
/** React Query hooks over the typed endpoints. Server state lives here, not in stores. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  createProject,
  detectPhrases,
  detectSilence,
  exportAudio,
  getJob,
  getProject,
  getWaveform,
  putEdl,
  queryKeys,
} from "./endpoints";

const DEFAULT_POLL_MS = 1000;

/** Fetch a project; disabled until `projectId` is known. */
export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.project(projectId ?? "none"),
    queryFn: ({ signal }) => getProject(projectId as string, signal),
    enabled: Boolean(projectId),
  });
}

interface UseJobOptions {
  /** Poll interval while the job is pending/running (ms). */
  pollMs?: number;
  /** On success, invalidate the job's project query so derived data refetches. */
  invalidateProject?: boolean;
}

/**
 * Poll `GET /jobs/{id}` until the job settles (succeeded/failed), then stop. Optionally
 * invalidates the affected project query on success so the waveform/silence/marker data
 * refetches once detection or extraction completes.
 */
export function useJob(jobId: string | undefined, options: UseJobOptions = {}) {
  const { pollMs = DEFAULT_POLL_MS, invalidateProject = false } = options;
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.job(jobId ?? "none"),
    queryFn: ({ signal }) => getJob(jobId as string, signal),
    enabled: Boolean(jobId),
    refetchInterval: (q) => {
      const state = q.state.data?.state;
      return state === "succeeded" || state === "failed" ? false : pollMs;
    },
  });

  const succeeded = query.data?.state === "succeeded";
  const projectId = query.data?.project_id ?? null;
  useEffect(() => {
    if (invalidateProject && succeeded && projectId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
    }
  }, [invalidateProject, succeeded, projectId, queryClient]);

  return query;
}

/** Precomputed waveform peaks; immutable per source, so cache them indefinitely. */
export function useWaveform(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.waveform(projectId ?? "none"),
    queryFn: ({ signal }) => getWaveform(projectId as string, signal),
    enabled: Boolean(projectId),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/** Start extraction: `POST /projects` -> `{ project_id, job_id }`. */
export function useCreateProject() {
  return useMutation({
    mutationFn: (body: CreateProjectRequest) => createProject(body),
  });
}

export function useDetectSilence(projectId: string) {
  return useMutation({
    mutationFn: (params: SilenceParams) => detectSilence(projectId, params),
  });
}

export function useDetectPhrases(projectId: string) {
  return useMutation({
    mutationFn: (body: PhraseRequest) => detectPhrases(projectId, body),
  });
}

/** Persist the EDL and patch the cached project so the editor stays in sync. */
export function usePutEdl(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (operations: EditOperation[]) => putEdl(projectId, operations),
    onSuccess: (edl) => {
      queryClient.setQueryData<ProjectView>(queryKeys.project(projectId), (prev) =>
        prev ? { ...prev, edl } : prev,
      );
    },
  });
}

export function useExport(projectId: string) {
  return useMutation({
    mutationFn: (body: ExportRequest) => exportAudio(projectId, body),
  });
}
