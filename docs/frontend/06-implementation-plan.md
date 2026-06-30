# Implementation Plan

> Status: active. Concrete build plan derived from docs 00-05 and the **already-built**
> FastAPI backend in `sawt_sakinah/service/`. This is the source of truth for the build
> order, the theme, and the API contract the frontend targets. Where the planning docs
> and the live backend disagree, **the backend wins** (deltas tabulated below).

## Confirmed decisions

- **Theme:** purple, not the base theme's burgundy. Primary `#450377`, hover `#38025f`,
  accent `#9667ba`. See [Theme tokens](#theme-tokens).
- **Arabic type:** two-font pairing — **Amiri** (logo + headings, echoes Ibarra Real
  Nova) and **IBM Plex Sans Arabic** (UI labels + marker chips, echoes Futura).
- **Shell:** minimal slim header over a full-bleed editor. No sidebar.
- **Scope:** a single in-flight project (`/` link input -> `/p/:projectId` editor ->
  export). No recent-projects list, so **no new backend list endpoint is needed** in v1.

## Stack

React 18 + TypeScript, Vite, React Router 6, `@tanstack/react-query` v5, Tailwind 3 +
CSS custom properties, Zustand (later phases, for the high-frequency playhead slice),
wavesurfer.js v7 (Phase 4), Biome for lint/format. The built SPA is ultimately served by
FastAPI and opened in a pywebview window; in dev we run Vite and proxy API calls.

## Backend reality vs. planning docs (build against the code)

The service layer is fully implemented. Key deltas from docs 00/05:

| Planning doc | Live backend (authoritative) |
|---|---|
| Job state `done`/`failed` | `pending \| running \| succeeded \| failed` (`service/jobs.py`) |
| `progress` is a number | `progress` is an arbitrary **dict** per job kind |
| `waveform` returns "peaks" | `{version, sample_rate, buckets, duration_sec, min[], max[]}` (`service/waveform.py`) |
| generic routes | mounted at **root**: `/projects`, `/jobs` (no `/api` prefix); writes return `202 Accepted` |
| FastAPI serves the SPA | **not wired** yet, and **no CORS** middleware |
| `SilenceSegment.mean_db` | optional; `duration` is a computed field (present in JSON) |

Consequences:

1. **Dev loop:** Vite (`:5173`) proxies `/projects` and `/jobs` to FastAPI (`:8000`).
   No CORS needed because the proxy makes it same-origin. No backend change for dev.
2. **Production / pywebview:** add a `StaticFiles` mount + SPA catch-all to
   `service/app.py` serving the built `frontend/dist`. This is the **only** backend
   change the frontend needs, and it lands in Phase 7.
3. **Waveform adapter:** the backend's `{min[], max[]}` must be converted to
   wavesurfer v7's per-channel peak format (Phase 4).

## API contract (typed in `src/types/api.ts`)

Endpoints (all relative, same-origin via proxy / static mount):

```
POST /projects                          { url, audio_format?, audio_quality? }
                                          -> 202 { project_id, job_id }            # extraction
GET  /jobs/{job_id}                      -> JobRecord
GET  /projects/{id}                      -> ProjectView
POST /projects/{id}/detect/silence       SilenceParams        -> 202 { job_id }
POST /projects/{id}/detect/phrases       PhraseRequest        -> 202 { job_id }
PUT  /projects/{id}/edl                  { operations[] }     -> EditDecisionList
POST /projects/{id}/export               ExportRequest        -> 202 { job_id }
GET  /projects/{id}/audio                -> audio stream (HTTP range)
GET  /projects/{id}/waveform             -> WaveformPeaks
GET  /projects/{id}/exports/{artifactId} -> file download
```

Wire shapes mirror the pydantic models exactly (`service/schemas.py`, `models/`):
`ProjectView`, `AudioSourceView`, `SilenceSegment`, `Marker`, `PrayerPosition`,
`EditOperation` (`cut|keep|fade|marker`), `EditDecisionList`, `ExportArtifactView`,
`JobRecord` (`kind: extract|detect_silence|detect_phrases|export`). All times are
**seconds (float)** across the boundary.

Errors: failed sync calls return `{ error, detail }` with a typed status
(400/403/404/422/451/502 per `service/app.py`); async failures surface in
`JobRecord.error` / `error_type`.

## Build order

- **Phase 0 - Scaffold & theme** *(this PR)*: Vite+React+TS app under `frontend/`,
  purple token set + four `@font-face`s, Tailwind + Biome config, Vite API proxy,
  router skeleton (`/`, `/p/:projectId`).
- **Phase 1 - API layer** *(this PR)*: typed wire types, a thin fetch client with typed
  errors, React Query hooks (`useCreateProject`, `useJob` polling, `useProject`,
  `useDetectSilence`, `useDetectPhrases`, `usePutEdl`, `useExport`), and a
  job-state -> view-state mapper.
- **Phase 2 - UI primitives**: `Button`, `Card`, `Input`, `Modal`, `Badge`, `Progress`,
  `Slider`, `Tooltip`, `LoadingSpinner`, `Tabs`, `Toast`, `EmptyState`, `Alert`.
- **Phase 3 - Shell & landing**: minimal header; landing card -> `POST /projects` ->
  navigate + extraction progress.
- **Phase 4 - Waveform & transport**: wavesurfer v7 wrapper (instance in `useRef`),
  peaks adapter, audio streaming, isolated playhead slice, transport controls.
- **Phase 5 - Silence editing**: region overlays, detection sliders (debounced
  re-detect), region list, bulk actions, client-side undo/redo over the EDL, debounced
  `PUT /edl`.
- **Phase 6 - Markers & prayer structure**: marker lines + Arabic chips, confidence
  styling, drag-to-adjust, prayer outline panel, reference-clip workflow.
- **Phase 7 - Export + backend static mount**: export modal/flow; add `StaticFiles` +
  SPA catch-all to `service/app.py`; pywebview entry.

## Theme tokens

Replacing the base theme's burgundy with purple. `#450377` carries AA contrast for white text
and on the cream background; `#9667ba` is mid-tone and used for accent bars / hovers /
selection, never for small body text on cream.

```
--color-accent            #450377   primary; played waveform; markers; focus ring
--color-accent-hover      #38025f   button hover / active
--color-accent-secondary  #9667ba   selected-region bar; marker hover; chips; highlights
--color-accent-soft       rgba(69,3,119,0.10)   region fill / subtle backgrounds
--color-border-focus      #450377
```

Backgrounds (cream), text (slate), and semantic colors (error/success/warning/info)
are inherited unchanged from the base theme's token set.

## Fonts

Self-hosted under `frontend/public/fonts/` (the CSP in the pywebview/static-served build
forbids CDN fetches). Tailwind `fontFamily`: `serif`->Ibarra Real Nova, `sans`->Futura,
`arabic-display`->Amiri, `arabic`->IBM Plex Sans Arabic. Amiri and IBM Plex Sans Arabic
are OFL and redistributable; Ibarra Real Nova (OFL) and Futura must be copied from
the base theme's assets. See `frontend/public/fonts/README.md` for exact filenames.

## State model (later phases)

Server state (project, job, waveform) lives in React Query caches. Local editor state
(selection, playhead, zoom, in-progress EDL, undo/redo) lives in React state / a small
Zustand store, with the high-frequency `currentTime`/playhead isolated in its own slice
so per-frame updates don't re-render the editor tree. The waveform's regions/markers are
a **projection** of app state, reconciled in effects keyed on the silence/marker lists.
