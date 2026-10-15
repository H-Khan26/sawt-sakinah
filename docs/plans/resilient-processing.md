# Resilient Processing & Checkpoint Support

> Status: proposed, not started. This document describes gaps in the existing backend
> and frontend, then proposes concrete work. Nothing here changes the shipped editor;
> it layers on top.
> The phrase/marker parts it describes (B5's chunked phrase detection appending to
> `project.markers`) were retired by the [Surah view](../frontend/04-surah-view.md); see
> [docs/audio/03-surah-recognition.md](../audio/03-surah-recognition.md).

---

## Problem statement

Quran recitations can run from a few minutes to several hours (full 30-juz recordings,
tarawih nights). The current architecture processes everything in memory with no
checkpointing, no persistence of in-flight state, and no recovery on restart:

- **Jobs vanish on restart.** `JobRegistry` is a plain in-memory dict. If the server
  restarts mid-extraction, the client receives a 404 on `GET /jobs/{id}` with no
  indication of whether the audio was partially downloaded.
- **No intermediate saves during detection.** Silence detection and Whisper transcription
  run to completion or fail entirely — a 2-hour file that crashes at 90% restarts from
  zero.
- **No retry logic.** A transient network blip during yt-dlp download fails the job
  permanently.
- **Shutdown is not graceful.** `ThreadPoolExecutor.shutdown(wait=False)` abandons
  in-flight threads; partial audio and artifact files can linger on disk orphaned.
- **Frontend loses job context on page refresh.** `jobId` lives only in React Router
  state; a hard refresh mid-extraction silently drops the polling loop.

---

## Current state (reference)

| Concern | Today |
|---|---|
| Job storage | In-memory dict only; lost on process exit |
| Project storage | `project.json` per project; atomic writes via `os.replace` |
| Audio files | Written to `<projects_root>/<id>/audio/` by yt-dlp/ffmpeg; survive restart |
| Intermediate detection results | None — only final lists written to `project.json` |
| Retry | None |
| Timeout | Each ffmpeg/ffprobe run stops after `ffmpeg.timeout_sec` |
| Graceful shutdown | Queued jobs dropped; running ones get `service.shutdown_grace_sec` to stop, then are recorded as cancelled |
| yt-dlp partial files | yt-dlp writes `.part` files; they survive restart but are never resumed |
| Whisper model | In-memory cache (`transcribe._MODEL_CACHE`) used by the transcription pool; reloaded on restart |
| Frontend job state | Router `location.state` only; lost on refresh |

---

## Proposed work

### Backend

#### B1 — Persist job state to disk

**Gap:** `JobRegistry._jobs` is a dict in RAM.

**Proposal:** Write each `JobRecord` as `<projects_root>/jobs/<job_id>.json` atomically
(same `os.replace` pattern used for `project.json`) on every state transition
(`pending → running → succeeded/failed`) and on every `update_progress` call. Read all
`jobs/*.json` on startup to rebuild the registry.

Key decisions:
- Keep the in-memory dict as the hot-path read; disk writes are fire-and-forget on the
  same thread (no extra I/O thread needed — jobs already run in worker threads).
- Cap stored jobs: after N days (configurable, default 7) or when the project is deleted,
  remove orphaned job files. A startup sweep handles this.
- Add a `config.service.job_ttl_days` field to `defaults.yaml`.

**Effect:** after a restart `GET /jobs/{id}` returns the last-known state (e.g.
`state=running` → frontend knows extraction was mid-flight and shows an appropriate UI
rather than a 404).

---

#### B2 — Job recovery on startup

**Gap:** jobs that were `running` when the server died are stuck in that state forever
(or silently dropped if B1 isn't done).

**Proposal:** During the FastAPI lifespan startup, after rebuilding the registry from
disk (B1), scan for any jobs in state `pending` or `running`:

- `running` jobs whose `updated_at` is older than a configurable stale threshold (default
  5 min): transition to `failed` with `error="server_restart"` /
  `error_type="ServerRestartError"`. The frontend `Alert` can map this to "The server
  restarted mid-extraction — try again."
- `pending` jobs: decide per-kind — extraction/detection jobs are safe to re-queue
  automatically because their work is idempotent (audio file may already exist on disk
  from the previous run; detection overwrites with fresh results).
- Add `ServerRestartError` to the frontend error title map in `EditorPage.tsx`.

---

#### B3 — yt-dlp resume for partial downloads

**Gap:** yt-dlp writes `.part` files while downloading; if extraction is killed and
re-run, it re-downloads from zero (yt-dlp's `--continue` flag is not set).

**Proposal:** Pass `continuedl=True` (yt-dlp's programmatic equivalent of `--continue`)
in the `ydl_opts` dict inside `extract_audio()`. When a `.part` file exists in the
project audio dir, yt-dlp resumes from the byte offset — no code change needed beyond
passing the flag. The progress hook already emits `downloaded_bytes` / `total_bytes` so
the frontend bar picks it up naturally.

Also set `noprogress=False` and keep the existing `_make_download_hook` — no change
needed there.

---

#### B4 — Chunked silence detection with intermediate saves

**Gap:** `detect_silence()` returns a single list after processing the entire file.
For a 2-hour file this is a ~30s blocking call with no partial output.

**Proposal:** Split the audio into N-minute chunks (configurable, default 20 min) before
detection, run detection on each chunk in sequence, translate timestamps back to the full
timeline, and append results to `project.silences` after each chunk via `store.update`.

```
audio duration 120 min, chunk 20 min:
  chunk 0 [0–20]   → detect → append silences → progress(stage=detect, chunk=1/6, ...)
  chunk 1 [20–40]  → detect → append silences → progress(stage=detect, chunk=2/6, ...)
  ...
  chunk 5 [100–120]→ detect → append silences → progress(stage=detect, chunk=6/6, done)
```

- Use ffmpeg to slice without re-encoding: `ffmpeg -ss <start> -to <end> -c copy`.
- On restart the existing silences in `project.json` are the last checkpoint; a fresh
  detection job replaces them all (idempotent). Full resume isn't needed — re-detection
  is fast enough at the chunk granularity.
- `progress` dict gains `chunk` / `total_chunks` fields for the frontend bar.

---

#### B5 — Chunked Whisper transcription with intermediate saves

**Gap:** `transcribe()` (surah recognition) runs Whisper over all the speech in one packed
pass and saves `audio/transcript.json` only when it finishes. One failure loses everything.

**Proposal:** Segment audio into chunks (configurable, default 10 min for phrase
detection — smaller than silence chunks because Whisper is heavier), transcribe each
chunk, translate marker timestamps, append to `project.markers` after each chunk.

```
  chunk 0  → transcribe → markers[0..k]   → store.update (append)
  chunk 1  → transcribe → markers[k..m]   → store.update (append)
  ...
```

Key considerations:
- **Context bleed:** Whisper performs better with a small overlap (e.g. 10s) between
  chunks. Deduplicate markers that land in the overlap zone by time proximity
  (`min_gap_between_markers` from `SilenceParams`).
- **Restart resume:** Check `project.markers` on startup; if non-empty and the job is
  being re-run (state `running` at restart), skip chunks whose end time is before the
  last saved marker's time. This makes long phrase jobs genuinely resumable.
- `progress` dict gains `chunk` / `total_chunks` / `elapsed_sec` for better ETA.

---

#### B6 — Retry with backoff for transient failures

**Gap:** a yt-dlp network blip fails the job permanently.

**Proposal:** Add `max_retries: int = 3` and `retry_backoff_sec: float = 5.0` to
`ServiceSettings`. In `JobRegistry._run`, catch specific transient exception types
(network errors, yt-dlp `DownloadError` with a retryable status code) and re-run the
task body up to `max_retries` times with exponential backoff before marking the job
failed. Non-retryable errors (`PrivateVideoError`, `RegionLockedError`, etc.) still fail
immediately.

---

#### B7 — Per-job timeout and graceful shutdown

**Gap:** a hung ffmpeg process blocks a worker thread forever.

**Proposal:**
- Add `job_timeout_sec: int = 3600` (1 hour) to `ServiceSettings`. Wrap the task body
  in a `concurrent.futures.wait([future], timeout=job_timeout_sec)` call and cancel +
  mark failed on timeout.
- Change `executor.shutdown(wait=True, cancel_futures=False)` in the lifespan shutdown.
  Combined with B1 (disk persistence), in-flight jobs get their state written before the
  process exits. If `wait=True` is too slow for the deployment context, add a
  `shutdown_grace_sec` config field.

---

### Frontend

#### F1 — Persist active job in sessionStorage

**Gap:** `jobId` lives in `location.state`; a hard refresh drops the polling loop and
shows the empty state instead of resuming progress.

**Proposal:** In `EditorPage`, after mounting with a valid `jobId`, write it (and `url`)
to `sessionStorage` keyed by `projectId`. On mount without router state, check
sessionStorage before falling back to the direct project fetch. Clear the entry when the
job reaches a terminal state.

```ts
// on mount with router state
sessionStorage.setItem(`sawt:job:${projectId}`, JSON.stringify({ jobId, url }))

// on mount without router state
const saved = sessionStorage.getItem(`sawt:job:${projectId}`)
const { jobId, url } = saved ? JSON.parse(saved) : {}
```

This is a single `useEffect` in `EditorPage` with no new dependencies. Pairs with B1 so
that after a server restart, `GET /jobs/{id}` still returns the persisted state instead
of a 404.

---

#### F2 — Handle stale / post-restart jobs gracefully

**Gap:** if the server restarts, `GET /jobs/{id}` currently 404s, and the frontend
interprets this as a network error rather than a restart.

**Proposal:**
- The query client already retries on 5xx and stops on 4xx. Add a specific branch in
  `EditorPage` for `ApiError.status === 404` on the job query (not the project query):
  show an `Alert` "The server restarted mid-extraction. Try again." with the retry button.
- When B1 + B2 are done, `GET /jobs/{id}` returns the persisted `failed` state with
  `error_type="ServerRestartError"` — the existing error-title map in `EditorPage` picks
  it up without additional changes.

---

#### F3 — Richer progress display for chunked jobs

**Gap:** `JobProgress` shows a single progress bar; chunked detection (B4/B5) emits
per-chunk progress that could be displayed more usefully.

**Proposal:** Extend `JobProgress` to read `chunk` / `total_chunks` from `progress` and
render an additional line "Chunk 3 of 6 · 47% overall" alongside the existing bar. The
`ratio` calculation uses `(chunk - 1 + chunk_pct) / total_chunks` for an overall
estimate. Backward-compatible — jobs without these fields fall back to current behavior.

---

## Out of scope / deferred

| Item | Reason |
|---|---|
| Multi-user / project sharing | Single-user desktop tool in v1 |
| SQLite or Postgres job store | JSON files on disk are sufficient for single-process; revisit if multi-worker deployment is needed |
| Distributed task queue (Celery, RQ) | Same as above |
| Streaming Whisper output (word-by-word) | Whisper's Python API doesn't expose this; would require a C++ binding |
| Cloud storage (S3, GCS) for audio | Out of scope for desktop/local deployment |
| Project versioning / undo history beyond in-session EDL | Not planned |

---

## Suggested implementation order

1. **B1 (persist jobs)** — highest leverage: immediately makes restarts recoverable and
   unblocks F2.
2. **F1 (sessionStorage)** — frontend-only, small, pairs with B1 to close the
   refresh-drops-progress gap.
3. **B3 (yt-dlp resume)** — one-line change, high value for long downloads.
4. **B2 (startup recovery)** — depends on B1; straightforward once jobs are on disk.
5. **B6 (retry backoff)** — protects against transient network failures in production.
6. **B4 (chunked silence)** + **F3 (richer progress)** — medium complexity; unblocks
   long-video silence editing.
7. **B5 (chunked Whisper)** — highest complexity; only needed once long-video phrase
   detection is a real use case.
8. **B7 (timeout + graceful shutdown)** — polish; do alongside B5 since that's the job
   most likely to hang.
