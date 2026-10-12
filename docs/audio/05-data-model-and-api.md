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
  id            str
  source_url    str
  local_path    str
  title         str
  duration_sec  float
  sample_rate   int
  channels      int
  codec         str
  content_hash  str
  created_at    datetime

SilenceSegment
  start         float      # seconds
  end           float
  duration      float
  mean_db       float

Marker
  id            str
  time          float      # seconds (phrase onset)
  end           float?     # optional
  label         str        # "Allahu Akbar"
  type          str        # takbir | tasmi | tahmid | tasleem | custom
  confidence    float      # 0..1
  source        str        # "auto" | "user"

PrayerPosition
  index         int
  name          str        # qiyam | ruku | itidal | sujood | julus | tasleem
  rakah         int
  start         float
  end           float?
  derived_from  list[str]  # marker ids that produced this position

EditOperation / EditDecisionList   # see 04-editing-and-export.md

Project                            # the top-level container
  id            str
  audio_source  AudioSource
  silences      list[SilenceSegment]
  markers       list[Marker]
  structure     list[PrayerPosition]
  edl           EditDecisionList
  status        per-stage status (extracted / analyzed / edited)
```

A **Project** is what the frontend loads and works against. It bundles the audio plus
all derived data and the current edit state.

## On-disk format and versioning

Each project is a folder under the projects directory holding `project.json`,
`audio/`, `exports/` and a cached `waveform.json`. `project.json` is the `Project` model
dumped as JSON plus a top-level `schema_version` integer (currently **1**; files from
before versioning have none and count as 0).

- **Migrations** live in `models/migrations.py`: a registry of `version -> step`
  functions applied in order on every load (v0 -> v1 fills the library name, timestamps
  and `source_kind` that early files lack). The upgraded form is written on the next
  save; the store always writes the current version, never an older one.
- **Newer files are refused.** A `schema_version` above the app's is never loaded or
  rewritten: `GET /projects/{id}` answers 409 `ProjectTooNewError` ("This project was
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
POST /projects                 { url }                 -> { project_id, job_id }   # starts extraction
GET  /jobs/{job_id}            -> { state, progress, error? }
GET  /projects/{id}            -> Project
POST /projects/{id}/detect/silence   { params }        -> { job_id }
POST /projects/{id}/detect/phrases   { params, refs }  -> { job_id }
GET  /projects                 -> { projects: [ProjectSummary] }   # unreadable ones flagged
DELETE /projects/{id}          -> 204, or 409 ProjectInUseError while files are locked
GET  /projects/{id}/audio      -> audio stream (range requests for waveform/seek)
GET  /projects/{id}/waveform   -> precomputed peaks (optional, for fast rendering)
PUT  /projects/{id}/edl        { operations }          -> updated EDL
POST /projects/{id}/export     { format, params }      -> { job_id } -> artifact
```

- **Progress**: poll `GET /jobs/{id}` or push via WebSocket/SSE. Wire yt-dlp and
  detection progress hooks into this.
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
`audio_format`, `audio_quality`, `model_size`, `device`, `compute_type`, `detector`) are
checked against allow-lists in `service/schemas.py`, and export paths must stay inside
the project's exports folder. The YouTube cookies preferences are checked the same way:
`cookies_browser` against a fixed browser allow-list (`GET /app/info` lists the ones
offered on this OS), `cookies_file` as an absolute path to an existing local file (no
network share); at most one is set.

## Contract discipline

- These types are defined **once** (pydantic) and shared across detection, editing, and
  API. The frontend keeps a hand-maintained typed mirror in `frontend/src/types/api.ts`.
- All times are **seconds (float)** everywhere — no mixing ms/samples across the
  boundary. Document the convention and stick to it.
- Detection endpoints return data and **never** alter audio; only `/export` (editing)
  produces files. This mirrors the module separation.
