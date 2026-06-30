# Data Model & Service API

> Status: planning. Defines the contracts shared across layers and the service surface
> the frontend talks to. An implementing agent chooses the concrete framework and
> persistence; the shapes below are the target.

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

## Suggested stack (for the agent to confirm)

- **API**: FastAPI (Python) — same language as the audio engine; native async; clean
  job endpoints. Pydantic models double as the contracts above.
- **Jobs**: start simple (FastAPI `BackgroundTasks` / a thread or process pool). Move
  to a real queue (Celery/RQ/arq + Redis) only if concurrency/scale demands it.
- **Persistence**: begin with on-disk project JSON + audio files in a project dir;
  introduce SQLite/Postgres if multi-user or history is needed. Don't over-build first.

## Contract discipline

- Define these types **once** (pydantic) and share them across detection, editing, and
  API. The frontend gets a generated/typed mirror (see frontend docs).
- All times are **seconds (float)** everywhere — no mixing ms/samples across the
  boundary. Document the convention and stick to it.
- Detection endpoints return data and **never** alter audio; only `/export` (editing)
  produces files. This mirrors the module separation.
