/**
 * Wire types mirroring the backend's pydantic contracts. Hand-kept in sync with
 * `sawt_sakinah/service/schemas.py` and `sawt_sakinah/models/`. All times are
 * **seconds (float)**; there is no unit conversion across this boundary.
 */

// --- analysis output (models/) ----------------------------------------------

/** `models/segments.py` SilenceSegment. `duration` is a computed field. */
export interface SilenceSegment {
  start: number;
  end: number;
  mean_db: number | null;
  duration: number;
}

export type MarkerType = "takbir" | "tasmi" | "tahmid" | "tasleem" | "custom" | string;
export type MarkerSource = "auto" | "user";

/** `models/markers.py` Marker. `duration` is a computed field (null when no `end`). */
export interface Marker {
  id: string;
  time: number;
  end: number | null;
  label: string;
  type: MarkerType;
  confidence: number;
  source: MarkerSource;
  duration: number | null;
}

export type PrayerPositionName =
  | "qiyam"
  | "ruku"
  | "itidal"
  | "sujood"
  | "julus"
  | "tasleem"
  | string;

/** `models/structure.py` PrayerPosition. */
export interface PrayerPosition {
  index: number;
  name: PrayerPositionName;
  rakah: number;
  start: number;
  end: number | null;
  derived_from: string[];
}

// --- edit decision list (models/edl.py) -------------------------------------

export type EditOperationType = "cut" | "keep" | "fade" | "marker";

export interface EditOperation {
  type: EditOperationType;
  start: number;
  end: number | null;
}

export interface EditDecisionList {
  source_id: string;
  operations: EditOperation[];
  created_at: string;
  updated_at: string;
}

// --- project wire views (service/schemas.py) --------------------------------

export interface AudioSourceView {
  id: string;
  /** Provenance: `"youtube"` (downloaded) or `"upload"` (user file). */
  source_kind: "youtube" | "upload" | string;
  /** Canonical source URL; `null` for uploads. */
  source_url: string | null;
  /** The uploaded file's original name; `null` for YouTube sources. */
  original_filename: string | null;
  title: string;
  duration_sec: number;
  sample_rate: number;
  channels: number;
  codec: string;
  content_hash: string;
  created_at: string;
  /** Relative URL of the streamable audio (range requests supported). */
  audio_url: string;
  /** True once the speech-probability map for the source is persisted server-side; VAD
   * re-detects then reuse it instead of re-running the model over the audio. */
  has_speech_map: boolean;
}

export interface ExportArtifactView {
  id: string;
  format: string;
  duration_sec: number;
  bitrate: string | null;
  edl_ref: string | null;
  created_at: string;
  /** User-supplied export label; drives the download filename. */
  name: string | null;
  /** Relative URL to download the rendered file. */
  download_url: string;
}

export interface ProjectStatus {
  extracted: boolean;
  analyzed: boolean;
  edited: boolean;
}

export interface ProjectView {
  id: string;
  audio_source: AudioSourceView;
  /** User-facing library label; seeded from the source title, editable via PATCH. */
  name: string;
  silences: SilenceSegment[];
  markers: Marker[];
  structure: PrayerPosition[];
  edl: EditDecisionList;
  status: ProjectStatus;
  exports: ExportArtifactView[];
  created_at: string;
  updated_at: string;
}

/** `GET /projects` item — lightweight projection for the library list. */
export interface ProjectSummary {
  id: string;
  name: string;
  /** Provenance: `"youtube"` (downloaded) or `"upload"` (user file). */
  source_kind: "youtube" | "upload" | string;
  /** Canonical source URL; `null` for uploads. */
  source_url: string | null;
  duration_sec: number;
  created_at: string;
  updated_at: string;
  status: ProjectStatus;
  export_count: number;
  /** Why the project's file can't be loaded (too new or damaged), else `null`. When set,
   * `name` may be a fallback, `duration_sec` is 0, `status` is all false and `source_kind`
   * may be `"unknown"`; the project can only be deleted. */
  unreadable: string | null;
}

/** Body of `GET /projects`, most-recently-edited first. */
export interface ProjectListResponse {
  projects: ProjectSummary[];
}

// --- jobs (service/jobs.py) -------------------------------------------------

export type JobState = "pending" | "running" | "succeeded" | "failed";
export type JobKind =
  | "extract"
  | "detect_silence"
  | "detect_phrases"
  | "export"
  | "split"
  | "download_model"
  | "update_ytdlp";

/**
 * `GET /jobs/{id}`. `progress` is an arbitrary, per-kind dict: detection/export jobs
 * emit `{ stage, status }`; extraction emits the yt-dlp progress hook payload
 * (`status`, `downloaded_bytes`, `total_bytes`, ...); a model download emits
 * {@link ModelDownloadProgress}. `result` is the job's summary
 * (e.g. `{ project_id, duration_sec }`, `{ detector, fallback?, silences }`,
 * `{ artifact_id }`). A silence job reports the detector that actually ran; when the
 * requested VAD could not run it still succeeds with `detector: "ffmpeg"` and a
 * `fallback` reason, so callers must read `result` rather than infer from the request.
 */
export interface JobRecord {
  id: string;
  kind: JobKind;
  project_id: string | null;
  state: JobState;
  progress: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  error_type: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `result` of a `detect_silence` job. `detector` is the backend that actually ran, which
 * differs from the request when the VAD is unavailable; `fallback` then carries the reason
 * and is absent otherwise.
 */
export interface SilenceJobResult {
  detector: SilenceDetector;
  fallback?: string;
  silences: number;
}

// --- request DTOs (service/schemas.py) --------------------------------------

export interface CreateProjectRequest {
  url: string;
  audio_format?: string;
  audio_quality?: string;
}

export interface CreateProjectResponse {
  project_id: string;
  job_id: string;
}

export interface JobAccepted {
  job_id: string;
}

/** Silence detector backend: Silero speech-probability VAD (server default) or ffmpeg energy gate. */
export type SilenceDetector = "ffmpeg" | "vad";

/**
 * Body of `POST /projects/{id}/detect/silence`. `threshold_db` applies to the energy gate only;
 * `speech_threshold` / `min_speech_duration` to the VAD only; `min_silence_duration` to both.
 */
export interface SilenceParams {
  threshold_db?: number;
  min_silence_duration?: number;
  merge_gap?: number | null;
  measure_loudness?: boolean;
  detector?: SilenceDetector;
  /** Speech-probability cutoff, 0..1 (VAD only). */
  speech_threshold?: number;
  /** Shortest speech burst kept as speech, seconds (VAD only). */
  min_speech_duration?: number;
}

export interface PhraseParams {
  phrases?: string[] | null;
  /** Whisper model id; omitted, the backend uses the `whisper_model` preference. */
  model_size?: string;
  /** Inference device; the desktop build runs on the CPU only. */
  device?: "cpu";
  compute_type?: string;
  language?: string;
  min_confidence?: number;
  min_gap_between_markers?: number;
  max_word_gap?: number;
  vad_filter?: boolean;
  snap_window?: number;
  clip_merge_gap?: number;
  clip_pad?: number;
}

export interface PhraseRequest {
  params?: PhraseParams;
  references?: Record<string, unknown> | null;
}

export interface EdlUpdate {
  operations: EditOperation[];
}

/** Body of `PUT /projects/{id}/markers`; replaces the whole marker list (structure is
 * re-derived server-side). User-placed markers carry `source: "user"`. */
export interface MarkersUpdate {
  markers: Marker[];
}

export interface ExportRequest {
  format?: string;
  bitrate?: string | null;
  embed_markers?: boolean;
  /** Download-filename label; defaults to the project name. */
  name?: string | null;
  /** Optional source-time range: render only `[range_start, range_end]` (edits inside it
   * still applied), leaving the saved EDL untouched. Both must be set together. */
  range_start?: number | null;
  range_end?: number | null;
}

/** Body of `POST /projects/{id}/split` — carve a source-time range into a new project. */
export interface SplitRequest {
  range_start: number;
  range_end: number;
  /** Library label for the new project; defaults to a derived name. */
  name?: string | null;
}

/** Body of `PATCH /projects/{id}` — rename. Server rejects empty/whitespace-only names. */
export interface PatchProjectRequest {
  name: string;
}

// --- waveform peaks (service/waveform.py) -----------------------------------

/** `GET /projects/{id}/waveform` — per-bucket min/max pairs of the mono signal. */
export interface WaveformPeaks {
  version: number;
  sample_rate: number;
  buckets: number;
  duration_sec: number;
  min: number[];
  max: number[];
}

// --- app preferences, info and updates (/app) -------------------------------

/** `GET/PATCH /app/preferences` — per-user choices stored by the backend, not the browser. */
export interface AppPreferences {
  /** Check GitHub for a newer release once a day on launch. */
  update_check: boolean;
  /** The release version the user dismissed the update banner for. */
  dismissed_update: string | null;
  /** Id of the speech model phrase detection uses. */
  whisper_model: string;
  /** Show cut audio on the waveform instead of collapsing it out. */
  show_deleted: boolean;
  /** Silence detector last chosen in the silence panel. */
  silence_detector: SilenceDetector;
  /** Browser whose profile cookies YouTube imports use (one of `AppInfo.cookie_browsers`).
   * Mutually exclusive with `cookies_file`; both `null` means cookies are off. */
  cookies_browser: CookieBrowser | null;
  /** Absolute path to a Netscape-format cookies.txt that YouTube imports read. Mutually
   * exclusive with `cookies_browser`. */
  cookies_file: string | null;
  /** Keep yt-dlp up to date from PyPI (opt-in; off by default). */
  ytdlp_update: boolean;
}

/** Browsers YouTube cookies can be read from. */
export type CookieBrowser =
  | "chrome"
  | "edge"
  | "firefox"
  | "brave"
  | "chromium"
  | "vivaldi"
  | "opera"
  | "safari";

/** Body of `PATCH /app/preferences`; any subset of the fields. */
export type PreferencesPatch = Partial<AppPreferences>;

/** `GET /app/info`. `frozen` is true in the packaged desktop build. */
export interface AppInfo {
  version: string;
  frozen: boolean;
  /** Browsers offered for YouTube cookies on this OS, in display order. */
  cookie_browsers: CookieBrowser[];
}

/** `GET /app/update` — the backend's cached release check (honours the preferences). */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  /** Release page for `latest`. */
  url: string | null;
  update_available: boolean;
}

/** `GET /app/ytdlp` — the YouTube downloader in use and its opt-in self-update. */
export interface YtdlpStatus {
  /** The `ytdlp_update` preference. */
  enabled: boolean;
  /** yt-dlp release channel the update follows ("nightly" or "stable"). */
  channel: string;
  /** "bundled" (shipped with the app) or "updated" (downloaded from PyPI). */
  source: "bundled" | "updated" | null;
  version: string | null;
  ejs_version: string | null;
  bundled_version: string | null;
  /** Why a downloaded copy was not used at this launch. */
  fallback: string | null;
  /** A downloaded version that takes effect at the next launch. */
  pending_version: string | null;
  latest: string | null;
  checked_at: string | null;
  /** The last check's failure. */
  error: string | null;
  /** The check job pending or running right now (started at launch or by "Check now"). */
  check_job_id: string | null;
  check_state: "pending" | "running" | null;
}

// --- speech models (/models) ------------------------------------------------

/** `GET /models` item — one entry of the speech-model catalog. */
export interface SpeechModel {
  id: string;
  label: string;
  description: string;
  size_mb: number;
  installed: boolean;
  /** True for the model the `whisper_model` preference names. */
  selected: boolean;
  /** The in-flight `download_model` job, so progress resumes after a reload. */
  download_job_id: string | null;
}

/** `progress` of a `download_model` job. */
export interface ModelDownloadProgress {
  stage: "downloading" | string;
  bytes_done: number;
  bytes_total: number;
}

// --- error envelope (service/app.py) ----------------------------------------

/** One entry of FastAPI's request-validation `detail` list. */
export interface ValidationIssue {
  loc: (string | number)[];
  msg: string;
  type: string;
}

/**
 * Body of a failed request: a typed failure `{ error: ExceptionName, detail: str }`, or a
 * FastAPI 422 whose `detail` lists validation issues (no `error`).
 */
export interface ApiErrorBody {
  error?: string;
  detail: string | ValidationIssue[];
}
