import { ApiError } from "@/api/client";
import { useToast } from "@/components/ui";
import type {
  CreateProjectRequest,
  EditOperation,
  ExportRequest,
  Marker,
  PhraseRequest,
  ProjectSummary,
  ProjectView,
  SilenceParams,
} from "@/types/api";
/** React Query hooks over the typed endpoints. Server state lives here, not in stores. */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  createProject,
  deleteProject,
  detectPhrases,
  detectSilence,
  editSaveKey,
  exportAudio,
  getJob,
  getProject,
  getWaveform,
  listProjects,
  putEdl,
  queryKeys,
  renameProject,
  updateMarkers,
} from "./endpoints";

const DEFAULT_POLL_MS = 1000;

/**
 * Retry policy for the per-edit autosaves: give transient/server failures a few tries with
 * backoff, but never retry a 4xx (bad input won't fix itself). Mirrors the query default.
 */
const editSaveRetry = (failureCount: number, error: unknown) => {
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 3;
};
const editSaveRetryDelay = (attempt: number) => Math.min(500 * 2 ** attempt, 5000);

/** Fetch a project; disabled until `projectId` is known. */
export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.project(projectId ?? "none"),
    queryFn: ({ signal }) => getProject(projectId as string, signal),
    enabled: Boolean(projectId),
  });
}

/** The project library list. Refetches on focus so the grid stays fresh across tabs. */
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: ({ signal }) => listProjects(signal),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Rename a project. Optimistically patches both the library list and the project view, and
 * rolls back on error. The server returns the full view, so `onSuccess` reconciles from it.
 */
export function useRenameProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameProject(id, name),
    onMutate: async ({ id, name }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.projects });
      const prevList = queryClient.getQueryData<ProjectSummary[]>(queryKeys.projects);
      const prevProject = queryClient.getQueryData<ProjectView>(queryKeys.project(id));
      queryClient.setQueryData<ProjectSummary[]>(queryKeys.projects, (list) =>
        list?.map((p) => (p.id === id ? { ...p, name } : p)),
      );
      queryClient.setQueryData<ProjectView>(queryKeys.project(id), (p) => (p ? { ...p, name } : p));
      return { prevList, prevProject };
    },
    onError: (_err, { id }, ctx) => {
      if (ctx?.prevList) queryClient.setQueryData(queryKeys.projects, ctx.prevList);
      if (ctx?.prevProject) queryClient.setQueryData(queryKeys.project(id), ctx.prevProject);
    },
    onSuccess: (view) => {
      queryClient.setQueryData<ProjectView>(queryKeys.project(view.id), view);
      queryClient.setQueryData<ProjectSummary[]>(queryKeys.projects, (list) =>
        list?.map((p) => (p.id === view.id ? { ...p, name: view.name } : p)),
      );
    },
  });
}

/** Delete a project. Drops it from the cached list and removes its per-project queries. */
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: (_data, id) => {
      queryClient.setQueryData<ProjectSummary[]>(queryKeys.projects, (list) =>
        list?.filter((p) => p.id !== id),
      );
      queryClient.removeQueries({ queryKey: queryKeys.project(id) });
      queryClient.removeQueries({ queryKey: queryKeys.waveform(id) });
    },
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
  const { toast } = useToast();
  return useMutation({
    mutationKey: editSaveKey(projectId),
    mutationFn: (operations: EditOperation[]) => putEdl(projectId, operations),
    retry: editSaveRetry,
    retryDelay: editSaveRetryDelay,
    onSuccess: (edl) => {
      queryClient.setQueryData<ProjectView>(queryKeys.project(projectId), (prev) =>
        prev ? { ...prev, edl } : prev,
      );
    },
    onError: () => toast("Couldn't save your last edit. Use “retry” in the header.", "error"),
  });
}

/**
 * Persist the marker list and patch the cached project. The server re-derives prayer
 * structure from the markers and returns the full view, so we patch markers, structure,
 * and status together — keeping `PrayerStructurePanel` in sync in one shot.
 */
export function useUpdateMarkers(projectId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useMutation({
    mutationKey: editSaveKey(projectId),
    mutationFn: (markers: Marker[]) => updateMarkers(projectId, markers),
    retry: editSaveRetry,
    retryDelay: editSaveRetryDelay,
    onSuccess: (view) => {
      queryClient.setQueryData<ProjectView>(queryKeys.project(projectId), (prev) =>
        prev
          ? { ...prev, markers: view.markers, structure: view.structure, status: view.status }
          : view,
      );
    },
    onError: () => toast("Couldn't save your last edit. Use “retry” in the header.", "error"),
  });
}

export function useExport(projectId: string) {
  return useMutation({
    mutationFn: (body: ExportRequest) => exportAudio(projectId, body),
  });
}
