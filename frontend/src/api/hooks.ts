import { ApiError } from "@/api/client";
import { useToast } from "@/components/ui";
import { sameOps } from "@/lib/edl";
import { useSurahStore } from "@/stores/surahStore";
import type {
  AppPreferences,
  CreateProjectRequest,
  EditOperation,
  ExportRequest,
  PreferencesPatch,
  ProjectSummary,
  ProjectView,
  SilenceParams,
  SpeechModel,
  SplitRequest,
  SurahRequest,
  UpdateStatus,
} from "@/types/api";
/** React Query hooks over the typed endpoints. Server state lives here, not in stores. */
import {
  queryOptions,
  replaceEqualDeep,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  checkYtdlp,
  createProject,
  deleteModel,
  deleteProject,
  detectSilence,
  detectSurahs,
  downloadModel,
  exportAudio,
  getAppInfo,
  getJob,
  getPreferences,
  getProject,
  getUpdateStatus,
  getWaveform,
  getYtdlpStatus,
  listModels,
  listProjects,
  listSurahs,
  openExportFolder,
  openLogs,
  patchPreferences,
  pickExportFolder,
  putEdl,
  queryKeys,
  renameProject,
  revealExport,
  saveExport,
  splitProject,
  uploadProject,
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

/**
 * The local copy of a project's EDL for local-first saving: the ops of the latest edit, its
 * version (bumped on every edit), the latest version the server has stored, and how many saves
 * are queued or in flight. Present once the project has been edited in this session; from then
 * on its ops are the ones the project cache holds (see `keepLocalEdl`). The edit is unsaved
 * while `saved < version`, however long ago its save failed.
 */
interface LocalEdl {
  ops: EditOperation[];
  version: number;
  saved: number;
  saving: number;
}

const localEdls = new Map<string, LocalEdl>();

/** Listeners told whenever an edit save starts or settles (`useSaveState`, `settleEdl`). */
const saveListeners = new Set<() => void>();

function subscribeSaves(listener: () => void): () => void {
  saveListeners.add(listener);
  return () => saveListeners.delete(listener);
}

function notifySaves(): void {
  for (const listener of saveListeners) listener();
}

/** Whether the project has an EDL edit the server hasn't stored yet. */
export function hasUnsavedEdl(projectId: string): boolean {
  const local = localEdls.get(projectId);
  return !!local && local.saved < local.version;
}

/**
 * A project's edit saves as the header shows them: `saving` while an EDL save is queued or in
 * flight, `failed` while an EDL edit is unsaved, `saved` otherwise.
 */
export type SaveState = "saving" | "failed" | "saved";

function saveStateOf(projectId: string): SaveState {
  if ((localEdls.get(projectId)?.saving ?? 0) > 0) return "saving";
  return hasUnsavedEdl(projectId) ? "failed" : "saved";
}

/** Mutation scope of a project's EDL saves: they run one at a time, in order. */
const edlScope = (projectId: string) => `edl:${projectId}`;

/**
 * Wait for a project's queued EDL saves to finish, then fail if an edit is still unsaved, so a
 * render (export, split) never runs on an older EDL than the editor shows.
 */
async function settleEdl(projectId: string): Promise<void> {
  const saving = () => (localEdls.get(projectId)?.saving ?? 0) > 0;
  if (saving()) {
    await new Promise<void>((resolve) => {
      const unsubscribe = subscribeSaves(() => {
        if (saving()) return;
        unsubscribe();
        resolve();
      });
    });
  }
  if (hasUnsavedEdl(projectId)) {
    throw new Error("Your latest edit isn't saved yet. Use “retry” in the header, then try again.");
  }
}

/**
 * The project query's `structuralSharing`: every write to the query, a fetch or any
 * `setQueryData`, passes through it. Once the project has a local EDL, its ops replace the
 * written ones, so no writer (a refetch or a rename reply) can roll back an edit.
 */
function keepLocalEdl(prev: unknown, next: unknown): unknown {
  const project = next as ProjectView | undefined;
  const local = project && localEdls.get(project.id);
  const data =
    project && local && project.edl.operations !== local.ops
      ? { ...project, edl: { ...project.edl, operations: local.ops } }
      : project;
  return replaceEqualDeep(prev, data);
}

/**
 * Fetch a project; disabled until `projectId` is known. The cached EDL ops stay the local ones
 * (see `keepLocalEdl`); a fetch adopts the server's ops into the local copy only when they hold
 * every edit: no save was pending when it started, no edit came during it, and none is unsaved.
 */
export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.project(projectId ?? "none"),
    queryFn: async ({ signal }) => {
      const id = projectId as string;
      const local = localEdls.get(id);
      const before = local && { version: local.version, saved: local.saved };
      const project = await getProject(id, signal);
      const settled =
        local &&
        before &&
        before.saved === before.version &&
        local.version === before.version &&
        local.saved === local.version;
      if (settled && !sameOps(local.ops, project.edl.operations)) {
        local.ops = project.edl.operations;
      }
      return project;
    },
    structuralSharing: keepLocalEdl,
    enabled: Boolean(projectId),
  });
}

/** The library's recordings. Refetches on focus so the grid stays fresh across tabs. */
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: ({ signal }) => listProjects(signal),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

/**
 * Rename a project. Optimistically patches the name in both the library list and the project
 * view, and rolls it back on error. Only the name is taken from the server's reply.
 */
export function useRenameProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => renameProject(id, name),
    onMutate: async ({ id, name }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.projects });
      const prevList = queryClient.getQueryData<ProjectSummary[]>(queryKeys.projects);
      const prevName = queryClient.getQueryData<ProjectView>(queryKeys.project(id))?.name;
      queryClient.setQueryData<ProjectSummary[]>(queryKeys.projects, (list) =>
        list?.map((p) => (p.id === id ? { ...p, name } : p)),
      );
      queryClient.setQueryData<ProjectView>(queryKeys.project(id), (p) => (p ? { ...p, name } : p));
      return { prevList, prevName };
    },
    onError: (_err, { id }, ctx) => {
      if (ctx?.prevList) queryClient.setQueryData(queryKeys.projects, ctx.prevList);
      const prevName = ctx?.prevName;
      if (prevName != null) {
        queryClient.setQueryData<ProjectView>(queryKeys.project(id), (p) =>
          p ? { ...p, name: prevName } : p,
        );
      }
    },
    onSuccess: (view) => {
      queryClient.setQueryData<ProjectView>(queryKeys.project(view.id), (p) =>
        p ? { ...p, name: view.name } : p,
      );
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
      localEdls.delete(id);
      useSurahStore.getState().clearJob(id);
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
 * invalidates the affected project query on success so the waveform/silence/surah data
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

/**
 * Upload a local media file: `POST /projects/upload` -> `{ project_id, job_id }`. `onProgress`
 * (0..1) reports the browser->server send; server-side transcoding is then tracked via the
 * returned job id (same `useJob` poll as extraction). Mirrors `useCreateProject`.
 */
export function useUploadProject() {
  return useMutation({
    mutationFn: ({ file, onProgress }: { file: File; onProgress?: (f: number) => void }) =>
      uploadProject(file, { onProgress }),
  });
}

export function useDetectSilence(projectId: string) {
  return useMutation({
    mutationFn: (params: SilenceParams) => detectSilence(projectId, params),
  });
}

/** Start surah matching: `POST /detect/surahs` -> `{ job_id }`. */
export function useDetectSurahs(projectId: string) {
  return useMutation({
    mutationFn: (body: SurahRequest) => detectSurahs(projectId, body),
  });
}

/** The 114 surahs' names and ayah counts; fixed data, so cached for the session. */
export function useSurahs() {
  return useQuery({
    queryKey: queryKeys.surahs,
    queryFn: ({ signal }) => listSurahs(signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Queue a save of the project's latest local EDL. Saves run one at a time, in order (a shared
 * mutation scope); a save that finds a later one queued behind it skips, so a burst of edits
 * sends only the latest ops, and a retry always sends the latest. A reply is adopted only while
 * no later edit exists. On failure the local ops stay and the toast points to the header's retry.
 */
function useQueueEdlSave(projectId: string): () => void {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { mutate } = useMutation({
    scope: { id: edlScope(projectId) },
    mutationFn: async (version: number) => {
      const local = localEdls.get(projectId);
      // Nothing left unsaved, or a later save is queued and will send the latest ops.
      if (!local || local.saved >= local.version || version < local.version) return null;
      const sent = local.version;
      return { edl: await putEdl(projectId, local.ops), version: sent };
    },
    retry: editSaveRetry,
    retryDelay: editSaveRetryDelay,
    onMutate: () => {
      const local = localEdls.get(projectId);
      if (local) local.saving += 1;
      notifySaves();
    },
    onSuccess: (result) => {
      const local = localEdls.get(projectId);
      if (!result || !local) return;
      local.saved = Math.max(local.saved, result.version);
      if (result.version !== local.version) return; // a later edit owns the screen
      // Keep the local array when the server stored the same ops, so nothing keyed on it redraws.
      if (!sameOps(local.ops, result.edl.operations)) local.ops = result.edl.operations;
      queryClient.setQueryData<ProjectView>(queryKeys.project(projectId), (prev) =>
        prev ? { ...prev, edl: { ...result.edl, operations: local.ops } } : prev,
      );
    },
    onError: () => toast("Couldn't save your last edit. Use “retry” in the header.", "error"),
    onSettled: () => {
      const local = localEdls.get(projectId);
      if (local) local.saving -= 1;
      notifySaves();
    },
  });

  return useCallback(() => {
    const local = localEdls.get(projectId);
    if (local) mutate(local.version);
  }, [projectId, mutate]);
}

/**
 * Local-first EDL saving. The returned function makes new ops the project's local EDL and
 * applies them to the cached project at once, so the next edit or undo builds on them, then
 * saves them in the background (see `useQueueEdlSave`).
 */
export function useSaveEdl(projectId: string) {
  const queryClient = useQueryClient();
  const queueSave = useQueueEdlSave(projectId);

  return useCallback(
    (ops: EditOperation[]) => {
      const local = localEdls.get(projectId) ?? { ops, version: 0, saved: 0, saving: 0 };
      local.ops = ops;
      local.version += 1;
      localEdls.set(projectId, local);
      queryClient.setQueryData<ProjectView>(queryKeys.project(projectId), (prev) =>
        prev ? { ...prev, edl: { ...prev.edl, operations: ops } } : prev,
      );
      queueSave();
    },
    [projectId, queryClient, queueSave],
  );
}

/** The project's save state for the header (see `SaveState`), and a retry of an unsaved edit. */
export function useSaveState(projectId: string): { state: SaveState; retry: () => void } {
  const state = useSyncExternalStore(subscribeSaves, () => saveStateOf(projectId));
  const queueEdlSave = useQueueEdlSave(projectId);
  const retry = useCallback(() => {
    if (hasUnsavedEdl(projectId)) queueEdlSave();
  }, [projectId, queueEdlSave]);
  return { state, retry };
}

/** Start an export once the EDL saves have settled (see `settleEdl`). */
export function useExport(projectId: string) {
  return useMutation({
    mutationFn: async (body: ExportRequest) => {
      await settleEdl(projectId);
      return exportAudio(projectId, body);
    },
  });
}

/** Move an export kept in the project to the export folder, then refetch the project. */
export function useSaveExport(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (artifactId: string) => saveExport(projectId, artifactId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) }),
  });
}

/** Show an exported file in the OS file manager. */
export function useRevealExport(projectId: string) {
  return useMutation({ mutationFn: (artifactId: string) => revealExport(projectId, artifactId) });
}

/**
 * Copy source-time ranges, joined, into a new project: `POST /projects/{id}/split` ->
 * `{ project_id, job_id }`. The caller navigates to the new project carrying `job_id`, so the editor's normal
 * `useJob` poll tracks the render+import (same as extraction/upload).
 */
export function useSplitProject(projectId: string) {
  return useMutation({
    mutationFn: async (body: SplitRequest) => {
      await settleEdl(projectId);
      return splitProject(projectId, body);
    },
  });
}

// --- app preferences, info and updates ---------------------------------------

/** Backend-stored preferences. Loaded once per session; writes patch the cache directly. */
export const preferencesQuery = queryOptions({
  queryKey: queryKeys.preferences,
  queryFn: ({ signal }) => getPreferences(signal),
  staleTime: Number.POSITIVE_INFINITY,
});

export function usePreferences() {
  return useQuery(preferencesQuery);
}

/** PATCH a subset of preferences, optimistically applied to the cache and rolled back on error. */
export function usePatchPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: PreferencesPatch) => patchPreferences(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.preferences });
      const prev = queryClient.getQueryData<AppPreferences>(queryKeys.preferences);
      queryClient.setQueryData<AppPreferences>(queryKeys.preferences, (p) =>
        p ? { ...p, ...patch } : p,
      );
      return { prev };
    },
    onError: (_err, _patch, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(queryKeys.preferences, ctx.prev);
    },
    onSuccess: (prefs) => queryClient.setQueryData(queryKeys.preferences, prefs),
  });
}

/** App version and whether this is the packaged build. Fixed for the process lifetime. */
export function useAppInfo() {
  return useQuery({
    queryKey: queryKeys.appInfo,
    queryFn: ({ signal }) => getAppInfo(signal),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** The backend's release check. Fetched once per session; a failure just means no banner. */
export function useUpdateStatus() {
  return useQuery({
    queryKey: queryKeys.appUpdate,
    queryFn: ({ signal }) => getUpdateStatus(signal),
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
}

/** Dismiss the update banner for `latest`: hides it at once and stores the version. */
export function useDismissUpdate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (latest: string) => patchPreferences({ dismissed_update: latest }),
    onMutate: (latest) => {
      queryClient.setQueryData<UpdateStatus>(queryKeys.appUpdate, (u) =>
        u && u.latest === latest ? { ...u, update_available: false } : u,
      );
    },
    onSuccess: (prefs) => queryClient.setQueryData(queryKeys.preferences, prefs),
  });
}

/** The yt-dlp in use and its self-update state; refetched whenever Settings opens. */
export function useYtdlpStatus() {
  return useQuery({
    queryKey: queryKeys.ytdlp,
    queryFn: ({ signal }) => getYtdlpStatus(signal),
  });
}

/** Run the yt-dlp update check now; seeds the job cache so `useJob` polls it at once. */
export function useCheckYtdlp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => checkYtdlp(),
    onSuccess: (job) => queryClient.setQueryData(queryKeys.job(job.id), job),
  });
}

/** Open the logs folder in the OS file manager. */
export function useOpenLogs() {
  return useMutation({ mutationFn: () => openLogs() });
}

/** Choose the export folder in a native dialog; stores the returned preferences. */
export function usePickExportFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => pickExportFolder(),
    onSuccess: (prefs) => queryClient.setQueryData(queryKeys.preferences, prefs),
  });
}

/** Open the export folder in the OS file manager. */
export function useOpenExportFolder() {
  return useMutation({ mutationFn: () => openExportFolder() });
}

// --- speech models -------------------------------------------------------------

/** The speech-model catalog with install state and any in-flight download job. */
export function useModels() {
  return useQuery({
    queryKey: queryKeys.models,
    queryFn: ({ signal }) => listModels(signal),
  });
}

/**
 * Start a model download. Seeds the job cache with the returned record and stamps its id on
 * the model, so every `useModelDownload` watching that model starts polling at once.
 */
export function useDownloadModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (modelId: string) => downloadModel(modelId),
    onSuccess: (job, modelId) => {
      queryClient.setQueryData(queryKeys.job(job.id), job);
      queryClient.setQueryData<SpeechModel[]>(queryKeys.models, (list) =>
        list?.map((m) => (m.id === modelId ? { ...m, download_job_id: job.id } : m)),
      );
    },
  });
}

/** Remove a downloaded model, then refetch the catalog. */
export function useDeleteModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (modelId: string) => deleteModel(modelId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.models }),
  });
}
