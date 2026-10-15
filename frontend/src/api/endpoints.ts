/** Typed wrappers over the backend HTTP surface. One function per endpoint. */
import type {
  AppInfo,
  AppPreferences,
  CreateProjectRequest,
  CreateProjectResponse,
  EditDecisionList,
  EditOperation,
  ExportRequest,
  JobAccepted,
  JobRecord,
  Marker,
  PhraseRequest,
  PreferencesPatch,
  ProjectListResponse,
  ProjectView,
  SilenceParams,
  SpeechModel,
  SplitRequest,
  UpdateStatus,
  WaveformPeaks,
  YtdlpStatus,
} from "@/types/api";
import { type UploadOptions, request, upload } from "./client";

export const createProject = (body: CreateProjectRequest) =>
  request<CreateProjectResponse>("/projects", { method: "POST", body });

/** Upload a local media file; the backend transcodes it and returns `{ project_id, job_id }`. */
export const uploadProject = (file: File, opts?: UploadOptions) =>
  upload<CreateProjectResponse>("/projects/upload", file, opts);

/** The library list, most-recently-edited first. Returns just the summaries array. */
export const listProjects = (signal?: AbortSignal) =>
  request<ProjectListResponse>("/projects", { signal }).then((r) => r.projects);

/** Rename a project. Returns the full updated view (server re-derives nothing). */
export const renameProject = (projectId: string, name: string) =>
  request<ProjectView>(`/projects/${projectId}`, { method: "PATCH", body: { name } });

/** Delete a project and its audio + exports. Resolves on 204. */
export const deleteProject = (projectId: string) =>
  request<void>(`/projects/${projectId}`, { method: "DELETE" });

export const getProject = (projectId: string, signal?: AbortSignal) =>
  request<ProjectView>(`/projects/${projectId}`, { signal });

export const getJob = (jobId: string, signal?: AbortSignal) =>
  request<JobRecord>(`/jobs/${jobId}`, { signal });

export const detectSilence = (projectId: string, params: SilenceParams) =>
  request<JobAccepted>(`/projects/${projectId}/detect/silence`, { method: "POST", body: params });

export const detectPhrases = (projectId: string, body: PhraseRequest) =>
  request<JobAccepted>(`/projects/${projectId}/detect/phrases`, { method: "POST", body });

export const putEdl = (projectId: string, operations: EditOperation[]) =>
  request<EditDecisionList>(`/projects/${projectId}/edl`, {
    method: "PUT",
    body: { operations },
  });

/** Replace the marker list; returns the updated project (markers + re-derived structure). */
export const updateMarkers = (projectId: string, markers: Marker[]) =>
  request<ProjectView>(`/projects/${projectId}/markers`, {
    method: "PUT",
    body: { markers },
  });

export const exportAudio = (projectId: string, body: ExportRequest) =>
  request<JobAccepted>(`/projects/${projectId}/export`, { method: "POST", body });

/** Carve a source-time range into a new independent project. Returns `{ project_id, job_id }`. */
export const splitProject = (projectId: string, body: SplitRequest) =>
  request<CreateProjectResponse>(`/projects/${projectId}/split`, { method: "POST", body });

export const getWaveform = (projectId: string, signal?: AbortSignal) =>
  request<WaveformPeaks>(`/projects/${projectId}/waveform`, { signal });

export const getPreferences = (signal?: AbortSignal) =>
  request<AppPreferences>("/app/preferences", { signal });

/** Merge a subset of preferences; returns the full stored object. */
export const patchPreferences = (body: PreferencesPatch) =>
  request<AppPreferences>("/app/preferences", { method: "PATCH", body });

export const getAppInfo = (signal?: AbortSignal) => request<AppInfo>("/app/info", { signal });

export const getUpdateStatus = (signal?: AbortSignal) =>
  request<UpdateStatus>("/app/update", { signal });

export const getYtdlpStatus = (signal?: AbortSignal) =>
  request<YtdlpStatus>("/app/ytdlp", { signal });

/** Check PyPI for a newer yt-dlp now; returns the `update_ytdlp` job record. */
export const checkYtdlp = () => request<JobRecord>("/app/ytdlp/check", { method: "POST" });

/** Open the logs folder in the OS file manager. Resolves on 204. */
export const openLogs = () => request<void>("/app/open-logs", { method: "POST" });

/** Choose the export folder in a native dialog; returns the (possibly unchanged) preferences. */
export const pickExportFolder = () =>
  request<AppPreferences>("/app/export-folder/pick", { method: "POST" });

/** Open the export folder in the OS file manager. Resolves on 204. */
export const openExportFolder = () => request<void>("/app/export-folder/open", { method: "POST" });

/** Move an export kept in the project into the export folder; returns where it was saved. */
export const saveExport = (projectId: string, artifactId: string) =>
  request<{ saved_path: string }>(`/projects/${projectId}/exports/${artifactId}/save`, {
    method: "POST",
  });

/** Show an exported file in the OS file manager. Resolves on 204; 404 when it was moved. */
export const revealExport = (projectId: string, artifactId: string) =>
  request<void>(`/projects/${projectId}/exports/${artifactId}/reveal`, { method: "POST" });

export const listModels = (signal?: AbortSignal) => request<SpeechModel[]>("/models", { signal });

/** Start downloading a speech model; returns the `download_model` job record. */
export const downloadModel = (modelId: string) =>
  request<JobRecord>(`/models/${encodeURIComponent(modelId)}/download`, { method: "POST" });

/** Remove a downloaded speech model. Resolves on 204. */
export const deleteModel = (modelId: string) =>
  request<void>(`/models/${encodeURIComponent(modelId)}`, { method: "DELETE" });

/** Relative URLs for media the browser loads directly (not via `request`). */
export const audioUrl = (projectId: string) => `/projects/${projectId}/audio`;
export const exportDownloadUrl = (projectId: string, artifactId: string) =>
  `/projects/${projectId}/exports/${artifactId}`;

/** React Query cache keys. */
export const queryKeys = {
  projects: ["projects"] as const,
  project: (projectId: string) => ["project", projectId] as const,
  job: (jobId: string) => ["job", jobId] as const,
  waveform: (projectId: string) => ["waveform", projectId] as const,
  preferences: ["app", "preferences"] as const,
  appInfo: ["app", "info"] as const,
  appUpdate: ["app", "update"] as const,
  models: ["models"] as const,
  ytdlp: ["app", "ytdlp"] as const,
};

/** Mutation key prefix for the per-edit autosaves, so `SaveStatus` can observe them. */
export const editSaveKey = (projectId: string) => ["edit-save", projectId] as const;
