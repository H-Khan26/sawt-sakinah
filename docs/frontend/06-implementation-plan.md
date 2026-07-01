# Implementation Plan

> Status: active. The build plan for the Sawt Sakinah frontend, written so any agent can
> pick up a phase and execute it without re-deriving context. Phases 0-1 are **done**
> (code in `frontend/`); Phases 2-7 are specified below. Where the planning docs (00-05)
> and the live backend disagree, **the backend wins** — deltas are tabulated.

## Orientation

Sawt Sakinah is a single-purpose audio editor for Quran recitation: paste a YouTube link,
the backend extracts the audio, the UI renders an interactive waveform, the user removes
silent gaps and reviews detected takbir/prayer-position markers, then exports. The
frontend is a **view + control surface**; all heavy work (extraction, detection, render)
lives in the Python engine. See [00-overview.md](00-overview.md) for the vision.

**The backend is already built** — a FastAPI service in
[sawt_sakinah/service/](../../sawt_sakinah/service/) plus the engine in
[sawt_sakinah/](../../sawt_sakinah/). The frontend is a fresh React app, scaffolded
through Phase 1.

### Running it (dev)

```
# terminal 1 — API on :8000
uvicorn sawt_sakinah.service.app:app --reload
# terminal 2 — Vite on :5173 (proxies /projects + /jobs to :8000)
cd frontend && npm install && npm run dev
```

No CORS is configured on the backend; the Vite proxy in
[frontend/vite.config.ts](../../frontend/vite.config.ts) makes API calls same-origin.
Override the API target with `SAWT_API_URL`. Quality gates before any commit:
`npm run typecheck`, `npm run build`, `npx biome check --write src`.

## Confirmed decisions

- **Theme:** purple, not the base theme's burgundy. Primary `#450377`, hover `#38025f`,
  accent `#9667ba`. See [Theme tokens](#theme-tokens).
- **Arabic type:** Amiri (logo + headings, echoes Ibarra Real Nova) + IBM Plex Sans
  Arabic (UI labels + marker chips, echoes Futura).
- **Shell:** minimal slim header over a full-bleed editor. No sidebar.
- **Scope:** a single in-flight project (`/` link input -> `/p/:projectId` editor ->
  export). No recent-projects list, so no project-list backend endpoint is needed in v1.

## Stack & conventions

React 18 + TypeScript (strict), Vite, React Router 6, `@tanstack/react-query` v5,
Zustand (local editor state), wavesurfer.js v7 (Phase 4), Tailwind 3 + CSS custom
properties, Biome. Hard conventions, enforced by tooling — follow them in every phase:

- **`verbatimModuleSyntax` is on** — import types with `import type { ... }`.
- **Path alias `@/`** maps to `frontend/src/` (see tsconfig + vite config).
- **Times are seconds (float)** everywhere; never convert across the boundary.
- **State split:** server data lives in React Query caches (keys centralized in
  [endpoints.ts](../../frontend/src/api/endpoints.ts) `queryKeys`); local editor state
  (selection, playhead, zoom, in-progress EDL, undo/redo) lives in Zustand stores under
  `src/stores/`. Never duplicate server state into a store.
- **Waveform regions/markers are a projection of app state**, reconciled in effects keyed
  on the silence/marker lists — not their own source of truth.
- **Styling:** only the tokens below; no new colors. Selected = accent; destructive = red.
- **Errors:** the client throws a typed [`ApiError`](../../frontend/src/api/client.ts)
  (`status`, `type`); surface via `Alert`/`Toast`, with retry tied to the originating job.

## Backend reality vs. planning docs (build against the code)

| Planning doc said | Live backend (authoritative) | File |
|---|---|---|
| Job state `done`/`failed` | `pending \| running \| succeeded \| failed` | [jobs.py](../../sawt_sakinah/service/jobs.py) |
| `progress` is a number | arbitrary **dict** per job kind | [jobs.py](../../sawt_sakinah/service/jobs.py) / [workers.py](../../sawt_sakinah/service/workers.py) |
| waveform returns "peaks" | `{version, sample_rate, buckets, duration_sec, min[], max[]}` | [waveform.py](../../sawt_sakinah/service/waveform.py) |
| generic routes | mounted at **root** (`/projects`, `/jobs`), no `/api`; writes return `202` | [app.py](../../sawt_sakinah/service/app.py) |
| FastAPI serves the SPA | **not wired**; no CORS | [app.py](../../sawt_sakinah/service/app.py) (Phase 7) |
| `SilenceSegment.mean_db` | optional; `duration` is a computed field (present in JSON) | [segments.py](../../sawt_sakinah/models/segments.py) |
| reference clips drive detection | `references` is **ignored by the Whisper backend** (reserved for a planned embeddings detector) | [phrases.py](../../sawt_sakinah/detection/phrases.py) |
| marker / structure editing API | **none exists** — only create/get project, put EDL, detect, export, jobs, media | [routes/](../../sawt_sakinah/service/routes/) |

The two "none/ignored" rows are real gaps that shape Phases 5-6 — flagged again there.

## API contract

All endpoints are relative/same-origin. Typed in
[src/types/api.ts](../../frontend/src/types/api.ts); wrappers in
[src/api/endpoints.ts](../../frontend/src/api/endpoints.ts).

```
POST /projects                          { url, audio_format?, audio_quality? }
                                          -> 202 { project_id, job_id }            # extraction
GET  /jobs/{job_id}                      -> JobRecord
GET  /projects/{id}                      -> ProjectView    (404 until extraction succeeds)
POST /projects/{id}/detect/silence       SilenceParams        -> 202 { job_id }
POST /projects/{id}/detect/phrases       PhraseRequest        -> 202 { job_id }
PUT  /projects/{id}/edl                  { operations[] }     -> EditDecisionList
POST /projects/{id}/export               ExportRequest        -> 202 { job_id }
GET  /projects/{id}/audio                -> audio stream (HTTP range)
GET  /projects/{id}/waveform             -> WaveformPeaks
GET  /projects/{id}/exports/{artifactId} -> file download
```

Wire shapes mirror the pydantic models exactly
([schemas.py](../../sawt_sakinah/service/schemas.py),
[models/](../../sawt_sakinah/models/)): `ProjectView`, `AudioSourceView`,
`SilenceSegment`, `Marker`, `PrayerPosition`, `EditOperation` (`cut|keep|fade|marker`),
`EditDecisionList`, `ExportArtifactView`, `JobRecord`
(`kind: extract|detect_silence|detect_phrases|export`). Sync failures return
`{ error, detail }` with a typed status (400/403/404/422/451/502, table in
[app.py](../../sawt_sakinah/service/app.py)); async failures surface in
`JobRecord.error` / `error_type`.

### Jobs are the async backbone

Extraction, both detections, and export return `202 { job_id }`. Poll
`GET /jobs/{id}` until `state` is `succeeded`/`failed`, then refetch the affected
project. This is already implemented as [`useJob`](../../frontend/src/api/hooks.ts)
(stops polling on settle; pass `invalidateProject: true` to refetch the project on
success) and the [`jobToViewState`](../../frontend/src/api/viewState.ts) mapper
(`extracting | analyzing | exporting | ready | error`). Progress payloads:

- **extraction** — the yt-dlp hook dict (`status`, `downloaded_bytes`, `total_bytes`,
  `eta`, ...).
- **silence / phrases / export** — `{ stage, status }` (see the `*_worker` functions in
  [workers.py](../../sawt_sakinah/service/workers.py)).

## Current frontend file map (what Phases 0-1 produced)

```
frontend/
  vite.config.ts            dev server + /projects,/jobs proxy
  tailwind.config.js        token-bound theme (colors/fonts/radius/shadow)
  tsconfig.json  biome.json  package.json
  index.html
  public/fonts/README.md    which .woff2 files to drop in
  src/
    main.tsx                React root: QueryClientProvider + BrowserRouter
    App.tsx                 routes: / and /p/:projectId
    index.css               @font-face + design tokens (purple remap)
    pages/
      LandingPage.tsx       PLACEHOLDER (Phase 3 fleshes it out)
      EditorPage.tsx        PLACEHOLDER (Phases 4-6 fill it)
    types/api.ts            all wire types
    api/
      client.ts             fetch wrapper + ApiError
      endpoints.ts          one fn per route + queryKeys + url helpers
      hooks.ts              useProject/useJob/useWaveform/useCreateProject/
                            useDetect*/usePutEdl/useExport
      viewState.ts          job -> editor view-state mapper
    lib/queryClient.ts      QueryClient (retry policy keyed on ApiError.status)
```

Suggested places for new code (keep features cohesive): UI primitives in
`src/components/ui/`, layout in `src/components/layout/`, feature modules in
`src/features/<feature>/`, Zustand stores in `src/stores/`, shared helpers in `src/lib/`.

## Theme tokens

Defined in [src/index.css](../../frontend/src/index.css) and bound to Tailwind utilities
in [tailwind.config.js](../../frontend/tailwind.config.js) (`bg-accent`, `text-accent`,
`border-focus`, etc.). `#450377` carries AA contrast for white text and on the cream
background; `#9667ba` is mid-tone — use it for accent bars / hovers / selection, never
for small body text on cream. Backgrounds (cream), text (slate), and semantic colors
(error/success/warning/info) are inherited from the base theme unchanged.

```
--color-accent            #450377   primary; played waveform; markers; focus ring
--color-accent-hover      #38025f   button hover / active
--color-accent-secondary  #9667ba   selected-region bar; marker hover; chips; highlights
--color-accent-soft       rgba(69,3,119,0.10)   region fill / subtle backgrounds
--silence-fill / -selected / marker-line / waveform-played / -unplayed   derived waveform vars
```

## Fonts

Self-hosted under [frontend/public/fonts/](../../frontend/public/fonts/) (the
static-served / pywebview build runs under a CSP that forbids CDN fetches). Tailwind
families: `serif`->Ibarra Real Nova, `sans`->Futura, `arabic-display`->Amiri,
`arabic`->IBM Plex Sans Arabic. Until the `.woff2` files (listed in the fonts README) are
added, the fallback stacks render and `vite build` logs benign "didn't resolve" warnings.
Render Arabic with `lang="ar" dir="rtl"` so the right face + direction apply.

---

# Build phases

Each phase is independently shippable. Build order matters: 2 (primitives) unblocks 3-7;
4 (waveform) unblocks 5-6.

## Phase 2 — UI primitives  *(next)*

**Goal:** a small custom component library styled to the tokens. No Radix/shadcn/MUI.

**Build** in `src/components/ui/` (one file each, plus an `index.ts` barrel):
`Button` (variants primary/secondary/ghost/danger, sizes sm/md, loading state), `Card`,
`Input`, `Modal` + `SimpleModal` (focus trap, Esc-to-close, scrim), `Badge` (neutral +
per-marker-type color variants), `Progress` (determinate + indeterminate), `Slider`
(single + range, for detection thresholds), `Tooltip`, `LoadingSpinner`, `Tabs`
(keyboard-navigable), `Toast` (a provider mounted in `main.tsx` + a `useToast` hook),
`EmptyState`, `Alert` (semantic variants + optional retry action).

**Design:** Tailwind utilities bound to tokens; add a `.btn-*`/`.card-*` component class
only when a pattern repeats. Radius 10px (buttons/inputs), 14px (cards). Focus ring uses
`--color-border-focus`. Respect `prefers-reduced-motion`. Accessibility is part of "done":
roles/aria, Modal focus management, Tabs arrow keys. Add a tiny `cn()` class-merge helper
in `src/lib/cn.ts` (no new dependency).

**References:** component list in [01-layout-and-pages.md](01-layout-and-pages.md);
tokens in [00-overview.md](00-overview.md). **Done when:** a primitives gallery (temporary
route or Storybook-free demo page) renders each in light theme and the build/lint pass.

## Phase 3 — App shell & landing

**Goal:** the minimal header shell, the landing link-input flow, and the editor's
extraction-progress entry state.

**Build:** `src/components/layout/AppShell.tsx` + `AppHeader.tsx` (logo "Sawt Sakinah" in
`font-serif`, optional صوت سكينة in `font-arabic-display`, a "New" action); flesh out
[LandingPage.tsx](../../frontend/src/pages/LandingPage.tsx) (centered `Card` + `Input` +
primary `Button`, loose client-side YouTube-URL validation) and
[EditorPage.tsx](../../frontend/src/pages/EditorPage.tsx); add a `JobProgress` component
that renders both progress-dict shapes.

**Design — the key integration detail:** `GET /projects/{id}` **404s until extraction
succeeds**, so the editor must track the extraction `job_id`. On landing submit, call
`useCreateProject`, then `navigate(\`/p/${project_id}\`, { state: { jobId } })`. The
editor reads `jobId` from router state, runs `useJob(jobId, { invalidateProject: true })`,
and gates `useProject` (`enabled`) on that job having succeeded. Drive the view state from
`jobToViewState(job)` + project presence: `extracting` -> `analyzing` (when a detection
job runs) -> `ready` (project loaded, no active job) -> `exporting`. Map a failed
extraction job's `error_type` to an `Alert` with a retry that re-POSTs. Use `EmptyState`
for the no-link state.

**References:** [01-layout-and-pages.md](01-layout-and-pages.md),
[05-state-and-api-integration.md](05-state-and-api-integration.md); error status table in
[app.py](../../sawt_sakinah/service/app.py). **Done when:** a real YouTube link extracts
end-to-end and lands in the (placeholder) editor with live progress, and failures show a
retryable alert.

## Phase 4 — Waveform & transport  *(the core net-new component)*

**Goal:** render the track as an interactive waveform and provide transport; this is the
substrate Phases 5-6 draw onto.

**Build:** `src/features/waveform/` — `WaveformView.tsx` (the component),
`useWavesurfer.ts` (lifecycle hook), `peaks.ts` (the min/max adapter); a Zustand store
`src/stores/playbackStore.ts`; `src/features/transport/TransportBar.tsx`; a
`src/lib/themeColors.ts` exposing the waveform hex values (mirrors the CSS vars — note the
duplication and keep them in sync).

**Design:**
- Wrap wavesurfer v7: init in a `useEffect`, keep the instance in a `useRef` (never in
  React state), destroy in cleanup. StrictMode double-invokes effects in dev — make
  init/destroy idempotent.
- **Peaks adapter:** the backend returns separate `min[]`/`max[]` (~2000 buckets, see
  `service.waveform_buckets` in [defaults.yaml](../../sawt_sakinah/config/defaults.yaml));
  wavesurfer's `peaks` option wants per-channel arrays normalized to `[-1, 1]`. Convert to
  the min/max envelope wavesurfer expects; if the exact shape fights the lib version, fall
  back to passing `max[]` alone (loses the negative lobe but renders), or a custom canvas.
  Pass `url = audioUrl(id)` + `peaks` + `duration = peaks.duration_sec` so wavesurfer
  **streams** audio for playback (range requests via
  [media.py](../../sawt_sakinah/service/routes/media.py)) without decoding the whole file.
- **Theme:** `waveColor = --waveform-unplayed`, `progressColor`/`cursorColor =
  --waveform-played` (#450377).
- **Transport:** play/pause (spacebar, ignored while typing in inputs), click/drag seek,
  zoom (`[` / `]`), playback-rate selector (useful for fast recitation).
- **Isolate the playhead:** put `currentTime`/`isPlaying`/`duration`/`rate`/`zoom` in
  `playbackStore`, fed from wavesurfer's time events. Subscribe **only** the transport
  readout and the active-position indicator to `currentTime` so per-frame updates don't
  re-render the editor tree. Do not route `currentTime` through React Query or a tree-wide
  context.

**References:** [02-waveform-and-playback.md](02-waveform-and-playback.md);
[waveform.py](../../sawt_sakinah/service/waveform.py). **Done when:** press-and-play is
immediate, seek/zoom/rate work, and the editor tree doesn't re-render on every frame.

## Phase 5 — Silence editing

**Goal:** make silent gaps obvious and let the user remove them with an undoable,
non-destructive EDL, then export.

**Build:** `src/features/silence/` — `SilencePanel.tsx`, `SilenceList.tsx`,
`SilenceControls.tsx`, `regions.ts` (reconcile silences <-> wavesurfer regions),
`edl.ts` (UI-action -> op mapping + derive the kept timeline); a Zustand
`src/stores/editStore.ts` (`operations[]`, `undoStack`, `redoStack`, `selectedSilenceIds`).

**Design:**
- **Overlays:** one wavesurfer Regions entry per `SilenceSegment`; fill `--silence-fill`,
  selected = `--silence-fill-selected` + a solid `--silence-bar-selected` left bar; hover
  -> `Tooltip` (start/end/duration). Regions are read-only highlights in v1 (no drag);
  click toggles selection. Selection lives in `editStore`, reflected in both list and
  waveform. Reconcile in an effect keyed on `silences` + `selectedSilenceIds`.
- **Detection controls:** `threshold_db` slider (range ~-60..-20; default **-40**) and
  `min_silence_duration` slider (range ~0.2..5 s; default **1.0**) — defaults come from
  `CONFIG.silence` in [defaults.yaml](../../sawt_sakinah/config/defaults.yaml); brackets
  should straddle them. On change, debounce ~400 ms, call `useDetectSilence`, poll the
  job, and let `invalidateProject` refetch `silences` so regions re-reconcile. Show the
  count + total silent duration.
- **List + actions:** rows (index, start-end, duration, checkbox); click seeks + selects;
  "Select all/none"; "Remove selected" and "Remove all detected silence" (guard the bulk
  one with a confirm `Modal`); client-side **undo/redo** over the op list.
- **Edit model:** removing region `[s,e]` -> `{ type: "cut", start: s, end: e }`. Keep ops
  against the original timeline; never mutate loaded audio; re-derive the kept timeline for
  display. Persist via `usePutEdl` debounced (separate debounce from re-detection).
  Boundary fades are applied server-side at render — the UI only marks cuts.
- **Preview** (audition cuts pre-export) is optional for v1; relying on export + re-listen
  is acceptable. Note the decision in the PR.

**References:** [03-silence-editing-ui.md](03-silence-editing-ui.md);
[audio/02-silence-detection.md](../audio/02-silence-detection.md),
[audio/04-editing-and-export.md](../audio/04-editing-and-export.md);
[edl.py](../../sawt_sakinah/models/edl.py) (`EditOperation` is `cut|keep|fade|marker`,
`end` optional); `SilenceParams` in [schemas.py](../../sawt_sakinah/service/schemas.py).

## Phase 6 — Markers & prayer structure

**Goal:** surface detected takbirs/phrases as timeline markers, render the rak'ah/position
outline, and let the user navigate and correct it.

**Build:** `src/features/markers/` — `MarkerLayer.tsx`, `MarkerChip.tsx`,
`PrayerStructurePanel.tsx`, `structure.ts` (active-position selector),
`referenceClip.ts`; a Zustand `src/stores/markerStore.ts` for user overrides.

**Design:**
- **Markers:** a vertical line + `Badge`-styled chip per `Marker`, positioned by
  `time -> x`. Color by `type` (takbir = `--color-accent`; tasmi/tahmid/tasleem =
  accent-secondary / semantic variants). Low `confidence` -> lower opacity / dashed so the
  user knows what to verify. Arabic labels use `font-arabic` + `lang="ar" dir="rtl"`. Click
  -> seek; "Add marker at playhead" for manual annotation.
- **Prayer panel:** group `PrayerPosition[]` by `rakah`; click a position -> seek; the
  active position highlights as `currentTime` advances (subscribe to the playhead slice,
  pick the position whose `[start,end)` contains it). Surface count mismatches as a gentle
  `Alert`, not an error — recitations vary (qunut, sajdah tilawah). The backend derives
  structure from markers in [prayer/structure.py](../../sawt_sakinah/prayer/structure.py)
  (`derive_structure`); positions are a function of markers (+ user overrides).
- **Gap to design around (no backend endpoint):** there is **no marker/structure edit
  API** — markers/structure only arrive from `detect/phrases` inside the `Project`. So v1
  marker edits (move/relabel/delete, manual markers, rak'ah corrections) must live as a
  **client-side overlay** in `markerStore` (`source: "user"`) layered over the auto
  markers, with structure re-derived client-side. Flag in the PR if a persistence endpoint
  is wanted instead.
- **Reference-clip workflow:** wire "select a clean takbir region -> Use as reference" to
  `detect/phrases` with the `references` payload — but note it is currently **inert**: the
  Whisper backend ignores `references` (reserved for a planned embeddings detector, see
  [phrases.py](../../sawt_sakinah/detection/phrases.py)). Build the UI affordance; expect
  no accuracy change until that backend lands.
- **Timeline remap after cuts:** removing silence shifts the timeline. Document/confirm
  whether the backend recomputes/offsets marker times relative to the EDL on render, or the
  UI must map — this is an open cross-layer decision noted in
  [04-markers-and-prayer-structure.md](04-markers-and-prayer-structure.md).

**References:** [04-markers-and-prayer-structure.md](04-markers-and-prayer-structure.md);
[audio/03-phrase-detection.md](../audio/03-phrase-detection.md);
[markers.py](../../sawt_sakinah/models/markers.py) (`Marker.id` is derived from
`type`+`time`; `duration` is computed; `source` is `auto|user`),
[structure.py](../../sawt_sakinah/models/structure.py); `PhraseParams`/`PhraseRequest` in
[schemas.py](../../sawt_sakinah/service/schemas.py). Note Whisper detection is **slow**
and runs on a single-worker pool (`phrase_workers: 1`) — expect a long poll.

## Phase 7 — Export + backend static mount

**Goal:** the export flow, plus serving the SPA from FastAPI and a pywebview window.

**Build (frontend):** `src/features/export/` — `ExportButton.tsx`, `ExportModal.tsx`
(`format`, `bitrate`, `embed_markers` -> `ExportRequest`; `useExport` -> poll job ->
on success read the new `ExportArtifactView.download_url` and offer a download). Guard
export as the destructive/rendered step.

**Build (backend — the one frontend-driven backend change):** in
[app.py](../../sawt_sakinah/service/app.py), after `include_router` for the API, mount
`StaticFiles(directory=<frontend/dist>, html=True)` at `/` with an SPA catch-all that
returns `index.html` for unknown non-API paths (so React Router deep links work). Mount
only when `dist` exists so dev (Vite proxy) is unaffected; API routes must take precedence
over the catch-all. CORS stays unnecessary (same origin). Add a pywebview launcher (e.g.
`sawt_sakinah/desktop.py`) that starts uvicorn and opens a window at the local URL;
pywebview is a new dependency — add it as an optional extra in
[pyproject.toml](../../pyproject.toml).

**References:** shell section of [00-overview.md](00-overview.md);
[audio/04-editing-and-export.md](../audio/04-editing-and-export.md);
[export.py](../../sawt_sakinah/service/routes/export.py) and `export_worker` in
[workers.py](../../sawt_sakinah/service/workers.py) (returns `{ artifact_id }`);
`ExportRequest`/`ExportArtifactView` in
[schemas.py](../../sawt_sakinah/service/schemas.py). `embed_markers` default is `true`
(`CONFIG.editing` in [defaults.yaml](../../sawt_sakinah/config/defaults.yaml)).
