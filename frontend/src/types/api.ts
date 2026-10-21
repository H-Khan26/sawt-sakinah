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

/** `models/surahs.py` PassageLevel: `unsure` passages are shown flagged and never acted on. */
export type PassageLevel = "accept" | "unsure";

/**
 * `models/surahs.py` SurahPassage: one continuous stretch of recitation recognised as a run of
 * ayat of one surah, on the source timeline. `start` / `end` are padded into the pauses around it.
 */
export interface SurahPassage {
  /** Surah number, 1..114. */
  surah: number;
  /** First and last ayah heard (1-based, inclusive). */
  ayah_from: number;
  ayah_to: number;
  start: number;
  end: number;
  /** Matched transcript words over the words the passage spans (0..1). */
  confidence: number;
  level: PassageLevel;
}

/** `models/surahs.py` SurahMap: the result of one matching run. */
export interface SurahMap {
  /** Catalog id of the model the transcript came from. */
  model: string;
  matched_at: string;
  /** Accepted and unsure passages, ordered by `start`. */
  passages: SurahPassage[];
}

/** `GET /quran/surahs` item: Tanzil's metadata for one surah. */
export interface SurahInfo {
  number: number;
  /** Arabic name. */
  name: string;
  /** Transliteration, e.g. `Al-Faatiha`. */
  tname: string;
  /** English meaning. */
  ename: string;
  ayas: number;
  type: "Meccan" | "Medinan" | string;
}

// --- edit decision list (models/edl.py) -------------------------------------

export type EditOperationType = "cut" | "keep" | "fade";

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
  /** Provenance: a platform id (`"youtube"`, `"instagram"`, `"x"`, `"facebook"`; see
   * `PlatformInfo.id`) for a link import, or `"upload"` for a user file. */
  source_kind: string;
  /** Canonical source URL; `null` for uploads. */
  source_url: string | null;
  /** The uploaded file's original name; `null` for link imports. */
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
  /** True once a transcript is saved, so surahs can be matched again without transcribing. */
  has_transcript: boolean;
  /** Loudest sample of a link import in dBFS; `null` for uploads and older imports. */
  peak_dbfs: number | null;
  /** The link import's audio is silent (e.g. a reel whose music was removed). A warning only. */
  is_silent: boolean;
}

export interface ExportArtifactView {
  id: string;
  format: string;
  duration_sec: number;
  bitrate: string | null;
  edl_ref: string | null;
  created_at: string;
  /** User-supplied export label; drives the saved or downloaded file name. */
  name: string | null;
  /** Relative URL to download the rendered file; `null` once it was saved to a folder. */
  download_url: string | null;
  /** Where the desktop app saved the file. The user may have moved or deleted it since. */
  saved_path: string | null;
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
  /** The recognised surahs; `null` until matching has run. */
  surahs: SurahMap | null;
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
  /** Provenance: a platform id for a link import, or `"upload"` for a user file. */
  source_kind: string;
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
  | "detect_surahs"
  | "export"
  | "split"
  | "download_model"
  | "update_ytdlp";

/**
 * `GET /jobs/{id}`. `progress` is an arbitrary, per-kind dict: detection/export jobs
 * emit `{ stage, status }`; surah matching also emits {@link SurahJobProgress}; extraction
 * emits the yt-dlp progress hook payload (`status`, `downloaded_bytes`, `total_bytes`, ...); a
 * model download emits {@link ModelDownloadProgress}. `result` is the job's summary
 * (e.g. `{ project_id, duration_sec }`, `{ detector, fallback?, silences }`,
 * `{ artifact_id }`, `{ passages, accept, unsure }`). A silence job reports the detector that actually ran; when the
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
  /** What the user can do about a failed import, when anything. */
  error_action: ErrorAction | null;
  /** The platform id an import failed on, when known. */
  platform: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * `progress` of a `detect_surahs` job while it works: `transcribing` with the seconds of speech
 * handed to the model so far out of the total, then `matching`. It starts and ends with the
 * generic `{ stage: "detect", status }`.
 */
export interface SurahJobProgress {
  stage: "transcribing" | "matching" | string;
  done_sec?: number;
  total_sec?: number;
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

/** Body of `POST /projects/{id}/detect/surahs`. The model and thresholds come from the config. */
export interface SurahRequest {
  /** Match the saved transcript again instead of transcribing anew (server default true). */
  reuse_transcript?: boolean;
}

export interface EdlUpdate {
  operations: EditOperation[];
}

export interface ExportRequest {
  format?: string;
  bitrate?: string | null;
  /** Write the accepted surah passages as chapters (mp3 / m4a). */
  embed_chapters?: boolean;
  /** Download-filename label; defaults to the project name. */
  name?: string | null;
  /** Optional source-time range: render only `[range_start, range_end]` (edits inside it
   * still applied), leaving the saved EDL untouched. Both must be set together. */
  range_start?: number | null;
  range_end?: number | null;
}

/**
 * Body of `POST /projects/{id}/split` — copy source-time ranges, joined back to back, into a new
 * project. The server sorts the ranges and merges any that overlap or touch.
 */
export interface SplitRequest {
  /** `[start, end]` pairs in source seconds; at least one. */
  ranges: [number, number][];
  /** Library label for the new project; defaults to a derived name. */
  name?: string | null;
}

/** Body of `PATCH /projects/{id}` — rename. Server rejects empty/whitespace-only names. */
export interface PatchProjectRequest {
  name: string;
}

// --- waveform peaks (service/waveform.py) -----------------------------------

/**
 * `GET /projects/{id}/waveform` — per-bucket RMS levels of the mono signal, scaled so the
 * recording's loudest passages reach full height. `levels` is base64 bytes (`0..255`).
 */
export interface WaveformPeaks {
  version: number;
  sample_rate: number;
  /** Buckets per second. */
  rate: number;
  buckets: number;
  duration_sec: number;
  /** Level of full height in dBFS RMS. */
  scale_db: number;
  levels: string;
}

// --- app preferences, info and updates (/app) -------------------------------

/** `GET/PATCH /app/preferences` — per-user choices stored by the backend, not the browser. */
export interface AppPreferences {
  /** Check GitHub for a newer release once a day on launch. */
  update_check: boolean;
  /** The release version the user dismissed the update banner for. */
  dismissed_update: string | null;
  /** Show cut audio on the waveform instead of collapsing it out. */
  show_deleted: boolean;
  /** Silence detector last chosen in the silence panel. */
  silence_detector: SilenceDetector;
  /** Browser whose profile cookies link imports use (one of `AppInfo.cookie_browsers`).
   * Mutually exclusive with `cookies_file`; both `null` means cookies are off. */
  cookies_browser: CookieBrowser | null;
  /** Absolute path to a Netscape-format cookies.txt that link imports read. Mutually
   * exclusive with `cookies_browser`. */
  cookies_file: string | null;
  /** Keep yt-dlp up to date from PyPI (opt-in; off by default). */
  ytdlp_update: boolean;
  /** Colour theme; `system` follows the OS light/dark setting. */
  theme: ThemePreference;
  /** Open on the dome landing at launch ("Open under the dome"). */
  landing: boolean;
  /** Folder desktop exports are saved to; `null` means the Downloads folder. */
  export_dir: string | null;
  /** How the library lists recordings. */
  library_view: LibraryView;
  /** Tint the recognised surahs on the waveform and show the surah band. */
  surah_view: boolean;
  /** Include Al-Fatihah in the surah band and list (visual only). */
  show_fatihah: boolean;
}

/** The stored theme choice. */
export type ThemePreference = "system" | "day" | "night";

/** Library layout: niches in an arcade, or a ruled list. */
export type LibraryView = "icons" | "list";

/** Browsers sign-in cookies can be read from. */
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
  /** Browsers offered for sign-in cookies on this OS, in display order. */
  cookie_browsers: CookieBrowser[];
  /** Exports are saved straight to a folder (the desktop app) instead of downloaded. */
  export_to_folder: boolean;
  /** The Downloads folder exports go to by default; `null` unless `export_to_folder`. */
  default_export_dir: string | null;
  /** The attribution the Tanzil terms ask for, shown under the speech model in Settings. */
  quran_text_credit: string;
}

/**
 * What fixes a failed link import: sign-in cookies in Settings, a newer downloader (yt-dlp), a
 * newer app, or trying again later.
 */
export type ErrorAction = "cookies" | "update_downloader" | "update_app" | "retry_later";

/** `GET /app/platforms` item — a site links import from, with its status in this install. */
export interface PlatformInfo {
  /** Also the `source_kind` of its imports. */
  id: string;
  label: string;
  /** What one link points at, for messages: `"video"` or `"post"`. */
  item: string;
  /** Registrable domains; a link's host is one of them or a subdomain. */
  hosts: string[];
  /** Regexes for share links, which the import job follows to the post. */
  share_patterns: string[];
  signin_often_needed: boolean;
  available: boolean;
  /** Available, but imports fail more often (a helper is missing). */
  limited: boolean;
  /** Why it is unavailable or limited. */
  reason: string | null;
  /** What fixes that. */
  action: ErrorAction | null;
  ytdlp_version: string;
}

/** `GET /app/update` — the backend's cached release check (honours the preferences). */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  /** Release page for `latest`. */
  url: string | null;
  update_available: boolean;
}

/** `GET /app/ytdlp` — the downloader (yt-dlp) link imports use and its opt-in self-update. */
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
  /** Why the active (or downloaded) yt-dlp can't impersonate a browser with the app's curl_cffi. */
  curl_cffi_conflict: string | null;
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
  /** Set for an extraction error (a refused link), as on a failed job. */
  error_action?: ErrorAction | null;
  platform?: string | null;
}
