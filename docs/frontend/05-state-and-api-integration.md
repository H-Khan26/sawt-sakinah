# State & API Integration

> Status: implemented. How the frontend holds state and talks to the audio engine's API.
> Uses TanStack React Query for server state and React state/stores for local state.

## Goal

A predictable data layer: server data fetched/cached via query, local editor state in
React state/stores, long-running backend work handled as jobs with progress — all typed
against the engine's contracts.

## Data sources, split cleanly

- **Server state** (owned by backend, fetched): `Project`, `AudioSource`,
  `SilenceSegment[]`, `Marker[]`, `PrayerPosition[]`, job status. Use
  `@tanstack/react-query` for fetching, caching, and refetch.
- **Local editor state** (owned by UI, ephemeral until saved): current selection,
  playhead, zoom, in-progress EDL, panel/tab state. Use React state, or a small store
  (Context + reducer, or Zustand) for state shared across panels. Keep the
  high-frequency playhead/current-time value in its own slice so it doesn't re-render
  unrelated UI (see [02-waveform-and-playback.md](02-waveform-and-playback.md)).
- **Source of truth rule:** the waveform's regions/markers are a **projection of app
  state**, not their own state. Edits update state → state reconciles the waveform.

## API client

Type a thin client against [../audio/05-data-model-and-api.md](../audio/05-data-model-and-api.md):

```
createProject(url)                  POST /projects               -> { project_id, job_id }
getJob(jobId)                       GET  /jobs/{id}              -> { state, progress, error? }
getProject(id)                      GET  /projects/{id}          -> Project
detectSilence(id, params)           POST /projects/{id}/detect/silence  -> { job_id }
detectPhrases(id, params, refs)     POST /projects/{id}/detect/phrases  -> { job_id }
putEdl(id, operations)              PUT  /projects/{id}/edl
exportAudio(id, params)             POST /projects/{id}/export   -> { job_id } -> artifact
audioUrl(id) / waveformUrl(id)      GET  streaming + peaks
```

Mirror the backend's contract types in `src/types/` so the whole app is typed end-to-end.
All times are **seconds (float)** — no unit conversion across the boundary.

## Jobs & progress (the async backbone)

Extraction, detection, and export are jobs, not instant responses:

- Kick off → receive `job_id` → **poll `GET /jobs/{id}`** with React Query
  `refetchInterval` until `state` is done/failed (or use WebSocket/SSE if the backend
  offers it). Drive `Progress` UI from the job's `progress` field.
- On completion, invalidate/refetch the affected project query so the waveform, silence
  list, and markers update.
- Map job states to the editor's view states (extracting / analyzing / ready /
  exporting) from [01-layout-and-pages.md](01-layout-and-pages.md).

## EDL persistence

- Debounce EDL mutations and `PUT` them so edits survive reloads.
- Keep undo/redo client-side over the EDL op list; persist the resulting EDL.

## Suggested store shape

```
playback:   { isPlaying, currentTime, duration, rate, zoom }
selection:  { selectedSilenceIds, activeMarkerId }
edl:        { operations[], undoStack, redoStack }
detection:  { silenceParams, phraseParams }
ui:         { activePanel, modals }
```

Server data (project, silences, markers, jobs) stays in React Query caches, not these
stores — avoid duplicating server state into local stores (a common source of drift).

## Error handling

- Surface typed backend errors (extraction failures, detection errors) via the base theme
  `Alert` / `Toast`. Provide retry actions tied to the originating job.
- Guard destructive/irreversible actions (export, "remove all silence") with confirms.
