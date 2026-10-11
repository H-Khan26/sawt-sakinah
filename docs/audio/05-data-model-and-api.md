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

## Async / job model (required)

Extraction and ML detection are slow (seconds–minutes). The API must not block:

```
POST /projects                 { url }                 -> { project_id, job_id }   # starts extraction
GET  /jobs/{job_id}            -> { state, progress, error? }
GET  /projects/{id}            -> Project
POST /projects/{id}/detect/silence   { params }        -> { job_id }
POST /projects/{id}/detect/phrases   { params, refs }  -> { job_id }
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
  body without `Content-Length` (chunked) gets 411, and a request with both
  `Content-Length` and `Transfer-Encoding` gets 400.

Request fields that reach file names, ffmpeg or model loading (`format`, `bitrate`,
`audio_format`, `audio_quality`, `model_size`, `device`, `compute_type`, `detector`) are
checked against allow-lists in `service/schemas.py`, and export paths must stay inside
the project's exports folder.

## Contract discipline

- These types are defined **once** (pydantic) and shared across detection, editing, and
  API. The frontend keeps a hand-maintained typed mirror in `frontend/src/types/api.ts`.
- All times are **seconds (float)** everywhere — no mixing ms/samples across the
  boundary. Document the convention and stick to it.
- Detection endpoints return data and **never** alter audio; only `/export` (editing)
  produces files. This mirrors the module separation.
