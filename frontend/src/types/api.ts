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
}

/** Body of `GET /projects`, most-recently-edited first. */
export interface ProjectListResponse {
  projects: ProjectSummary[];
}

// --- jobs (service/jobs.py) -------------------------------------------------

export type JobState = "pending" | "running" | "succeeded" | "failed";
export type JobKind = "extract" | "detect_silence" | "detect_phrases" | "export" | "split";

/**
 * `GET /jobs/{id}`. `progress` is an arbitrary, per-kind dict: detection/export jobs
 * emit `{ stage, status }`; extraction emits the yt-dlp progress hook payload
 * (`status`, `downloaded_bytes`, `total_bytes`, ...). `result` is the job's summary
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
  model_size?: string;
  device?: string;
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

// --- error envelope (service/app.py) ----------------------------------------

/** Body of a typed sync failure: `{ error: ExceptionName, detail: str }`. */
export interface ApiErrorBody {
  error: string;
  detail: string;
}
