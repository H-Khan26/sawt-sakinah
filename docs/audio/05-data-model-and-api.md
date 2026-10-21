# Data Model & Service API

> Status: implemented (`sawt_sakinah/models/` for the contracts, `sawt_sakinah/service/`
> for the FastAPI surface). Defines the contracts shared across layers and the service
> surface the frontend talks to; the pydantic models are the authoritative shapes.

## Why this doc

Every other layer is glued together by a small set of data types. The frontend renders
these types and posts edits back. Pin them down early — they are the most expensive
thing to change later.

## Core types

```
AudioSource
  id                 str
  source_kind        str        # platform id ("youtube", "instagram", "x", "facebook") | "upload"
  source_url         str?       # None for uploads
  original_filename  str?       # set for uploads
  local_path         path       # the mp3
  title              str
  duration_sec       float
  sample_rate        int
  channels           int
  codec              str
  content_hash       str
  created_at         datetime
  working_copy       path?      # 16 kHz mono WAV for detection
  speech_map         path?      # Silero speech-probability sidecar (.npz)
  transcript         path?      # Whisper word transcript sidecar (audio/transcript.json)
  peak_dbfs          float?     # peak level of a link import; <= -70 dBFS is flagged silent

SilenceSegment
  start         float      # seconds
  end           float
  duration      float
  mean_db       float

SurahPassage                       # see 03-surah-recognition.md
  surah         int        # 1..114
  ayah_from     int        # first ayah heard (inclusive)
  ayah_to       int        # last ayah heard (inclusive)
  start         float      # seconds, padded into the pause before
  end           float      # seconds, padded into the pause after
  confidence    float      # matched words / words spanned (0..1)
  level         str        # "accept" | "unsure"

SurahMap
  model         str        # catalog id of the Whisper model the transcript came from
  matched_at    datetime   # UTC
  passages      list[SurahPassage]   # ordered by start

EditOperation / EditDecisionList   # see 04-editing-and-export.md

Project                            # the top-level container
  id            str
  audio_source  AudioSource
  name          str        # library label
  silences      list[SilenceSegment]
  surahs        SurahMap?  # None until surah recognition has run
  edl           EditDecisionList
  status        per-stage status (extracted / analyzed / edited)
  exports       list[ExportArtifact]
  created_at / updated_at  datetime
```

A **Project** is what the frontend loads and works against. It bundles the audio plus
all derived data and the current edit state.

The wire form (`service/schemas.py::ProjectView`) is the same tree with server paths
stripped: `AudioSourceView` drops `local_path`, `working_copy`, `speech_map` and
`transcript` and adds `audio_url`, `has_speech_map` (speech-aware controls are available)
and `has_transcript` (surahs can be matched again without transcribing); exports carry a
`download_url` or, once saved to a user folder, `saved_path`.

## On-disk format and versioning

Each project is a folder under the projects directory holding `project.json`,
`audio/` (the mp3, the working copy, the speech map and `transcript.json`), `exports/`
and a cached `waveform.json`. `project.json` is the `Project` model dumped as JSON plus
a top-level `schema_version` integer (currently **2**; files from before versioning have
none and count as 0).

- **Migrations** live in `models/migrations.py`: a registry of `version -> step`
  functions applied in order on every load. v0 -> v1 fills the library name, timestamps
  and `source_kind` that early files lack; v1 -> v2 drops the `markers` and `structure`
  fields of the retired phrase detection and the `marker` ops in `edl.operations`, which
  the surah map replaced (a v2 file has `surahs` instead, `null` until recognition runs),
  and keeps `status.analyzed` only when silences remain. The upgraded form is written on
  the next save; the store always writes the current version, never an older one.
- **Missing files are healed on load**: a `working_copy`, `speech_map` or `transcript`
  whose file is gone is set to `null`, and exports kept in the project whose files are
  gone are dropped (exports saved to a user folder stay listed).
- **Newer files are refused.** A `schema_version` above the app's is never loaded or
  rewritten: `GET /projects/{id}` answers 409 `ProjectTooNewError` ("This recording was
  saved by a newer version of Sawt Sakinah. Update the app to open it."), and a damaged
  file answers 422 `ProjectUnreadableError`.
- **The library never breaks on one bad file.** `GET /projects` lists a project it
  can't read with `unreadable` set to the reason (other fields are placeholders); it can
  still be deleted.
- **Writes are atomic**: a temp file and a replace, retried briefly while Windows
  reports the target as open.
- **Partial files** carry `.part` (or `.tmp`) in their name until complete, e.g.
  `exports/<id>.part.mp3`.

### Deleting, shutdown and the startup sweep

- `DELETE /projects/{id}` closes the streams the server holds open on the project's
  files, refuses new ones, and renames the folder to `.deleting-<id>-<suffix>` (retried
  for about 1.5 s). On Windows the rename fails while any file inside is open, so a
  project still in use (by another program, a virus scanner) answers 409
  `ProjectInUseError` and is left untouched. After the rename the folder is removed; if
  that fails it is already hidden from the library and the next start removes it.
- **Shutdown** (closing the window) drops queued jobs, terminates the helper programs
  (ffmpeg) running jobs started, and makes the next progress report raise, so jobs stop
  and remove their partial outputs (an export's `.part` file, the folder of a project
  that was still being imported or split) within `service.shutdown_grace_sec` (3 s).
  Every job ends recorded as `JobCancelledError`; one still running after the budget is
  left to the process exit. Partially downloaded models are kept, since downloads
  resume.
- **Startup sweep** (`ProjectStore.sweep`, before the first request): removes
  `.deleting-*` folders, project folders without a `project.json` (an import that never
  finished) and partial files inside projects. Leftovers modified in the last 10 minutes
  are kept, in case another process sharing the data directory is still writing them.

## Async / job model (required)

Extraction and ML detection are slow (seconds–minutes). The API must not block:

```
POST /projects                 { url }                 -> { project_id, job_id }   # starts extraction; 400/409 for a refused link
GET  /jobs/{job_id}            -> { kind, state, progress, result?, error?, error_type?, error_action?, platform? }
GET  /projects/{id}            -> Project
POST /projects/{id}/detect/silence   { params }        -> { job_id }
POST /projects/{id}/detect/surahs    { reuse_transcript }  -> 202 { job_id }, or 409 when the model is missing
GET  /quran/surahs             -> [{ number, name, tname, ename, ayas, type }]   # the 114 surahs
GET  /projects                 -> { projects: [ProjectSummary] }   # unreadable ones flagged
DELETE /projects/{id}          -> 204, or 409 ProjectInUseError while files are locked
POST /projects/{id}/split      { ranges, name? }       -> { project_id, job_id }   # ranges into a new project
GET  /projects/{id}/audio      -> audio stream (range requests for waveform/seek)
GET  /projects/{id}/waveform   -> precomputed peaks (optional, for fast rendering)
PUT  /projects/{id}/edl        { operations }          -> updated EDL
POST /projects/{id}/export     { format, bitrate?, embed_chapters, name?, range_start?, range_end? }
                               -> { job_id } -> artifact
POST /projects/{id}/exports/{a}/save    -> { saved_path } (desktop: move into the folder)
POST /projects/{id}/exports/{a}/reveal  -> 204, or 404 once the file was moved
GET  /models                   -> [{ id, label, description, size_mb, installed, download_job_id? }]
POST /models/{id}/download     -> 202 download_model job
DELETE /models/{id}            -> 204, or 409 ModelBusyError while downloading or in use
GET  /app/info                 -> version, cookie_browsers, export folder info, quran_text_credit
GET  /app/platforms            -> [{ id, label, item, hosts, share_patterns, signin_often_needed, available, limited, reason?, action?, ytdlp_version }]
GET|PATCH /app/preferences     -> preferences
POST /app/export-folder/pick            -> preferences (native folder dialog)
```

- **Progress**: poll `GET /jobs/{id}`. Each job's `progress` is the last payload its
  worker reported and `result` its summary once it succeeds. A failed job records `error`
  (the message) and `error_type` (the exception class); an extraction failure adds
  `error_action` (`cookies`, `update_downloader`, `update_app`, `retry_later` or `null`)
  and `platform` (the site's id, when known).
- **Link check**: `POST /projects` runs the offline link stages before starting a job
  (see [01-extraction.md](01-extraction.md)). An invalid link, an unsupported site or a
  link that is not a single post answers 400; a site this install can't import from
  answers 409 `PlatformUnavailableError`. The body is `{ error, detail, error_action,
  platform }`, the same fields a failed job records. Share links pass and are resolved by
  the job.
- **Platforms**: `GET /app/platforms` lists the supported sites in order with their hosts
  and share-link patterns (for the client's own link check) and their status against the
  active yt-dlp (`available`, `limited`, `reason`, `action`).
- **Job kinds** (`service/jobs.py::JobKind`): `extract`, `detect_silence`,
  `detect_surahs`, `export`, `split`, `download_model`, `update_ytdlp`. Most run on the
  general pool (`service.max_workers`); `detect_surahs` runs on the dedicated
  `transcription` pool (`service.transcription_workers`, 1 by default, since concurrent
  Whisper on one device runs out of memory), and app housekeeping on a one-thread
  background pool.
- **Surah recognition** (`POST /projects/{id}/detect/surahs`, body `SurahRequest`):
  `reuse_transcript` (default `true`) matches the saved transcript again when it came
  from the current model instead of transcribing. The model (`surahs.model`) and the
  thresholds come from the config. The request answers 409 `ModelNotInstalledError` when
  the model isn't downloaded. Progress payloads, in order:
  `{"stage": "detect", "status": "start"}`, then
  `{"stage": "transcribing", "done_sec", "total_sec"}` while Whisper runs (seconds of the
  audio handed to it; absent when the transcript is reused), `{"stage": "matching"}`, and
  `{"stage": "detect", "status": "done"}`. The job stores `Project.surahs`, sets
  `status.analyzed`, and its result is `{"passages", "accept", "unsure"}` (counts). See
  [03-surah-recognition.md](03-surah-recognition.md).
- **Split** (`SplitRequest`): `ranges` is a list of `[start, end]` source-time pairs
  (1 to 500, each `0 <= start < end`), stored sorted with overlapping or touching ranges
  merged; a range starting at or past the recording's end is refused with 422, and an
  end past it is clamped. They are rendered back to back, with the source project's edits inside them
  applied, and imported as a new project; `name` defaults to the source name plus the
  ranges' extent (`1:05-9:40, 3 parts`).
- **Export** (`ExportRequest`): `embed_chapters` (default `editing.embed_chapters`,
  `true`) writes the accepted surah passages as chapters; see
  [04-editing-and-export.md](04-editing-and-export.md).
- **Models**: one catalog model, `quran-base`, used by surah recognition; there is no
  per-user model choice. A download job reports
  `{"stage": "downloading", "bytes_done", "bytes_total"}`.
- **App info and preferences**: `GET /app/info` includes `quran_text_credit`, the
  Tanzil attribution line the app shows wherever the Quran text is used. Preferences
  include `surah_view` (tint the recognised surahs on the waveform, default `true`) and
  `show_fatihah` (include Al-Fatihah in the surah band and list, default `true`); a
  stored key the app no longer uses (such as the retired `whisper_model`) is ignored.
- **Range requests** on the audio endpoint let the waveform component stream/seek.
- **Waveform peaks**: consider precomputing min/max peak data server-side so the
  frontend renders instantly instead of decoding the whole file in the browser.

## Stack

- **API**: FastAPI (Python) — same language as the audio engine; native async; clean
  job endpoints. The pydantic models double as the contracts above.
- **Jobs**: an in-process worker pool (`service/jobs.py`, `service/workers.py`) polled
  through `GET /jobs/{id}`. A real queue (Celery/RQ/arq + Redis) is only warranted if
  concurrency or scale ever demands it.
- **Persistence**: on-disk project JSON plus audio files in a per-project directory
  (`service/projects.py`); SQLite/Postgres only if multi-user or history is needed.

## Request guards

The service listens on localhost, so any web page the user opens can try to reach it.
`service/security.py` guards every request:

- **Host allow-list** (`SAWT_ALLOWED_HOSTS`, default `127.0.0.1` and `localhost`) blocks
  DNS rebinding.
- **Origin check**: a `POST`/`PUT`/`PATCH`/`DELETE` whose `Origin` is not the service's
  own (or listed in `SAWT_ALLOWED_ORIGINS`, which `make dev` sets for the Vite server)
  gets a 403, as does any request marked `Sec-Fetch-Site: cross-site`.
- **Launch token**: when `auth_token` is set (the desktop shell always sets one), every
  request needs the `X-Sawt-Token` header or the session cookie. The window loads
  `/_session?token=…`, which sets the cookie and redirects to `/`. `GET /health` answers
  200 only with a valid token. `make dev` runs without a token.
- **Upload size**: `POST /projects/upload` is refused from its `Content-Length` before the
  body is read.
- **Body size**: every other request body is capped at 8 MiB (413
  `RequestTooLargeError`), checked from its `Content-Length` before the body is read. A
  body without `Content-Length` (chunked) gets 411.
- **Response headers**: every response carries a Content Security Policy
  (`service/security.py::CONTENT_SECURITY_POLICY`): `default-src 'self'`, scripts, fonts
  and API calls from this origin only, images and media also from `blob:`/`data:`,
  `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'none'`.
  Styles allow `'unsafe-inline'` because wavesurfer injects a `<style>` element into its
  shadow DOM; inline scripts are refused. Also `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`. The dev Vite server serves the SPA without them.

Request fields that reach file names, ffmpeg or model loading (`format`, `bitrate`,
`audio_format`, `audio_quality`, `detector`) are checked against allow-lists in
`service/schemas.py`; the Whisper model, device and compute type are not request fields
at all (they come from the config), and export paths must stay inside
the project's exports folder. The sign-in cookies preferences are checked the same way:
`cookies_browser` against a fixed browser allow-list (`GET /app/info` lists the ones
offered on this OS), `cookies_file` as an absolute path to an existing local file (no
network share); at most one is set. `export_dir` must be an absolute path to an existing
local folder; the export request never carries a path, and the saved file's name comes
from the sanitized export name.

## Contract discipline

- These types are defined **once** (pydantic) and shared across detection, editing, and
  API. The frontend keeps a hand-maintained typed mirror in `frontend/src/types/api.ts`.
- All times are **seconds (float)** everywhere — no mixing ms/samples across the
  boundary. Document the convention and stick to it.
- Detection endpoints return data and **never** alter audio; only `/export` (editing)
  produces files. This mirrors the module separation.
