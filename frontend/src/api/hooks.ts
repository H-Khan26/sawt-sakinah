import { ApiError } from "@/api/client";
import { useToast } from "@/components/ui";
import { sameOps } from "@/features/cuts/cutEdl";
import type {
  AppPreferences,
  CreateProjectRequest,
  EditOperation,
  ExportRequest,
  Marker,
  PhraseRequest,
  PreferencesPatch,
  ProjectSummary,
  ProjectView,
  SilenceParams,
  SpeechModel,
  SplitRequest,
  UpdateStatus,
} from "@/types/api";
/** React Query hooks over the typed endpoints. Server state lives here, not in stores. */
import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import {
  checkYtdlp,
  createProject,
  deleteModel,
  deleteProject,
  detectPhrases,
  detectSilence,
  downloadModel,
  editSaveKey,
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
  updateMarkers,
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
 * version (bumped on every edit) and the latest version the server has stored. Present once the
 * project has been edited in this session.
 */
interface LocalEdl {
  ops: EditOperation[];
  version: number;
  saved: number;
}

const localEdls = new Map<string, LocalEdl>();

/** Mutation scope of a project's EDL saves: they run one at a time, in order. */
const edlScope = (projectId: string) => `edl:${projectId}`;

/**
 * Wait for a project's queued EDL saves to finish, then fail if an edit is still unsaved, so a
 * render (export, split) never runs on an older EDL than the editor shows.
 */
async function settleEdl(queryClient: QueryClient, projectId: string): Promise<void> {
  const cache = queryClient.getMutationCache();
  const saving = () =>
    cache.findAll({ status: "pending" }).some((m) => m.options.scope?.id === edlScope(projectId));
  if (saving()) {
    await new Promise<void>((resolve) => {
      const unsubscribe = cache.subscribe(() => {
        if (saving()) return;
        unsubscribe();
        resolve();
      });
    });
  }
  const local = localEdls.get(projectId);
  if (local && local.saved < local.version) {
    throw new Error("Your latest edit isn't saved yet. Use “retry” in the header, then try again.");
  }
}

/**
 * Lay the local ops over a fetched project when the fetch may predate them: a save was pending
 * when it started, or an edit came after it started, or one is unsaved now. Otherwise the
 * server copy holds every saved edit.
 */
function withLocalEdl(project: ProjectView, before: { version: number; saved: number }) {
  const local = localEdls.get(project.id);
  if (!local) return project;
  const stale =
    before.saved < before.version ||
    local.version !== before.version ||
    local.saved < local.version;
  return stale ? { ...project, edl: { ...project.edl, operations: local.ops } } : project;
}

/**
 * Fetch a project; disabled until `projectId` is known. A refetch (e.g. after an export) keeps
 * any EDL edits the server may not have yet, so it never rolls the editor back.
 */
export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.project(projectId ?? "none"),
    queryFn: async ({ signal }) => {
      const id = projectId as string;
      const local = localEdls.get(id);
      const before = { version: local?.version ?? 0, saved: local?.saved ?? 0 };
      return withLocalEdl(await getProject(id, signal), before);
    },
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
 * view, and rolls it back on error. Only the name is taken from the server's reply, so the
 * editor's unsaved EDL edits survive a rename.
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
        p ? { ...p, name: view.name } : view,
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

export function useDetectPhrases(projectId: string) {
  return useMutation({
    mutationFn: (body: PhraseRequest) => detectPhrases(projectId, body),
  });
}

/**
 * Local-first EDL saving. The returned function applies new ops to the cached project at once,
 * so the next edit or undo builds on them, then saves them in the background. Saves run one at a
 * time, in order (a shared mutation scope); a save that finds a later one queued behind it skips,
 * so a burst of edits sends only the latest ops, and a retry always sends the latest. A reply
 * is adopted only while no later edit exists. On failure the local ops stay and the toast points
 * to the header's retry (`SaveStatus`).
 */
export function useSaveEdl(projectId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { mutate } = useMutation({
    mutationKey: editSaveKey(projectId),
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
    onSuccess: (result) => {
      const local = localEdls.get(projectId);
      if (!result || !local) return;
      local.saved = Math.max(local.saved, result.version);
      if (result.version !== local.version) return; // a later edit owns the screen
      // Keep the local array when the server stored the same ops, so nothing keyed on it redraws.
      const operations = sameOps(local.ops, result.edl.operations)
        ? local.ops
        : result.edl.operations;
      local.ops = operations;
      queryClient.setQueryData<ProjectView>(queryKeys.project(projectId), (prev) =>
        prev ? { ...prev, edl: { ...result.edl, operations } } : prev,
      );
    },
    onError: () => toast("Couldn't save your last edit. Use “retry” in the header.", "error"),
  });

  return useCallback(
    (ops: EditOperation[]) => {
      const local = localEdls.get(projectId) ?? { ops, version: 0, saved: 0 };
      local.ops = ops;
      local.version += 1;
      localEdls.set(projectId, local);
      queryClient.setQueryData<ProjectView>(queryKeys.project(projectId), (prev) =>
        prev ? { ...prev, edl: { ...prev.edl, operations: ops } } : prev,
      );
      mutate(local.version);
    },
    [projectId, queryClient, mutate],
  );
}

/**
 * Persist the marker list and patch the cached project. The server re-derives prayer
 * structure from the markers and returns the full view, so we patch markers, structure,
 * and status together — keeping the prayer outline in sync in one shot.
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

/** Start an export once the EDL saves have settled (see `settleEdl`). */
export function useExport(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: ExportRequest) => {
      await settleEdl(queryClient, projectId);
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
 * Carve a source-time range into a new project: `POST /projects/{id}/split` -> `{ project_id,
 * job_id }`. The caller navigates to the new project carrying `job_id`, so the editor's normal
 * `useJob` poll tracks the render+import (same as extraction/upload).
 */
export function useSplitProject(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: SplitRequest) => {
      await settleEdl(queryClient, projectId);
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

/** The speech-model catalog with install/selection state and any in-flight download job. */
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

/**
 * Choose the active speech model (`whisper_model`). Optimistically moves the `selected` flag in
 * the catalog and the preference, rolls both back on error, and refetches the catalog after.
 */
export function useSelectModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (modelId: string) => patchPreferences({ whisper_model: modelId }),
    onMutate: async (modelId) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.models });
      const prevModels = queryClient.getQueryData<SpeechModel[]>(queryKeys.models);
      const prevPrefs = queryClient.getQueryData<AppPreferences>(queryKeys.preferences);
      queryClient.setQueryData<SpeechModel[]>(queryKeys.models, (list) =>
        list?.map((m) => ({ ...m, selected: m.id === modelId })),
      );
      queryClient.setQueryData<AppPreferences>(queryKeys.preferences, (p) =>
        p ? { ...p, whisper_model: modelId } : p,
      );
      return { prevModels, prevPrefs };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prevModels) queryClient.setQueryData(queryKeys.models, ctx.prevModels);
      if (ctx?.prevPrefs) queryClient.setQueryData(queryKeys.preferences, ctx.prevPrefs);
    },
    onSuccess: (prefs) => queryClient.setQueryData(queryKeys.preferences, prefs),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.models }),
  });
}
