# Implementation Plan

> Status: implemented; retained as the build record. The build plan for the Sawt Sakinah frontend, written so any agent can
> pick up a phase and execute it without re-deriving context. Phases 0-7 are **done**
> (code in `frontend/`), plus a small backend **marker layer** (Phase B) that Phases 6-7
> depend on. Where the planning docs (00-05) and the live backend disagree, **the backend
> wins** — deltas are tabulated.

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
# both servers in one terminal (recommended)
make dev

# or separately:
# terminal 1 — API on :8000 (autoreload)
python -m sawt_sakinah serve --reload
# terminal 2 — Vite on :5173 (proxies /projects + /jobs to :8000)
cd frontend && npm run dev
```

`make dev` runs [scripts/dev.py](../../scripts/dev.py), which launches both servers and
tears them down together on Ctrl-C. Cross-platform (Windows cmd/Git Bash, macOS, Linux).
Override host/port with `make dev HOST=0.0.0.0 PORT=9000`.

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
| FastAPI serves the SPA | **wired** (Phase 7): SPA served at `/` with a deep-link catch-all when `frontend/dist` exists; API routes take precedence; still no CORS | [app.py](../../sawt_sakinah/service/app.py) |
| `SilenceSegment.mean_db` | optional; `duration` is a computed field (present in JSON) | [segments.py](../../sawt_sakinah/models/segments.py) |
| reference clips drive detection | `references` is **ignored by the Whisper backend** (reserved for a planned embeddings detector); the reference-clip UI is **dropped from v1** | [phrases.py](../../sawt_sakinah/detection/phrases.py) |
| marker / structure editing API | **`PUT /projects/{id}/markers`** (Phase B) replaces the marker list and re-derives structure server-side | [routes/projects.py](../../sawt_sakinah/service/routes/projects.py) |

The reference-clip row remains inert (dropped from v1); the SPA-serving and marker-API rows
are now resolved by Phases 7 and B.

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
PUT  /projects/{id}/markers              { markers[] }        -> ProjectView   # re-derives structure
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

## Current frontend file map (what Phases 0-4 produced)

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
      LandingPage.tsx       link-input, validate, POST /projects, navigate
      EditorPage.tsx        entry state machine + EditorWorkspace (waveform + transport)
    types/api.ts            all wire types
    api/
      client.ts             fetch wrapper + ApiError
      endpoints.ts          one fn per route + queryKeys + url helpers
      hooks.ts              useProject/useJob/useWaveform/useCreateProject/
                            useDetect*/usePutEdl/useExport
      viewState.ts          job -> editor view-state mapper
    lib/
      queryClient.ts        QueryClient (retry policy keyed on ApiError.status)
      cn.ts                 class-merge helper
      themeColors.ts        hex mirrors of --waveform-*/--silence-*/--marker-* CSS vars
                            (canvas can't read custom properties; keep in sync with index.css)
      time.ts               formatClock(seconds) -> "m:ss"
    components/
      ui/                   Button, Card, Input, Modal, Badge, Progress, Slider,
                            Tooltip, LoadingSpinner, Tabs, Toast, EmptyState, Alert
      layout/               AppShell, AppHeader
      JobProgress.tsx       yt-dlp + {stage,status} progress shapes
    features/
      waveform/
        peaks.ts            toWavesurferPeaks: WaveformPeaks -> [max[], min[]] for wavesurfer
        useWavesurfer.ts    lifecycle hook: create/destroy in effect, events -> playbackStore,
                            Timeline + Hover plugins; rate/zoom applied via separate effects
        WaveformContext.tsx WaveformProvider + useWaveformContext (React context, not store ref)
        WaveformView.tsx    container div + load/error overlays
      transport/
        transportControls.ts  togglePlay / zoomIn / zoomOut (shared by bar + hotkeys)
        useTransportHotkeys.ts  Space=play/pause, [/]=zoom; ignored in form fields
        TransportBar.tsx    split subcomponents (TimeReadout subscribes currentTime alone,
                            PlayButton subscribes isPlaying alone) to isolate per-frame renders
    stores/
      playbackStore.ts      currentTime/duration/isPlaying/rate/zoom; fed from wavesurfer events;
                            selector-subscribe to avoid full-tree re-renders per frame
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

## Phase 2 — UI primitives  *(done)*

**Goal:** a small custom component library styled to the tokens. No Radix/shadcn/MUI.

**Built** in `src/components/ui/` (one file each, barrel at `index.ts`):

| Component | File | Notes |
|---|---|---|
| `Button` | `Button.tsx` | variants primary/secondary/ghost/danger, sizes sm/md, `loading` spinner |
| `Card` | `Card.tsx` | `rounded-card`, optional `header`/`footer` slots, `flush` prop |
| `Input` | `Input.tsx` | forwardRef, `invalid` + hint, `useId` for label pairing |
| `Modal` + `SimpleModal` | `Modal.tsx` | native `<dialog open>`, focus trap, Esc + scrim close |
| `Badge` | `Badge.tsx` | neutral + marker-type variants; exports `badgeVariantForMarker` + `markerTypeVariant` for Phase 6 |
| `Progress` | `Progress.tsx` | determinate (value 0–1) + indeterminate sweep; `role="progressbar"` |
| `Slider` + `RangeSlider` | `Slider.tsx` | native range inputs; range uses two overlaid inputs + accent filled track |
| `Tooltip` | `Tooltip.tsx` | hover + focus (bubbles from focusable child); CSS-positioned |
| `LoadingSpinner` | `LoadingSpinner.tsx` | SVG spinner; `<output>` element; `motion-reduce:animate-none` |
| `Tabs` | `Tabs.tsx` | roving tabIndex; Arrow/Home/End; controlled + uncontrolled |
| `ToastProvider` + `useToast` | `Toast.tsx` | context provider; auto-dismiss; `<output>` items |
| `EmptyState` | `EmptyState.tsx` | icon slot, title, description, optional action |
| `Alert` | `Alert.tsx` | error/success/warning/info; optional retry action button |

`cn()` class-merge helper in `src/lib/cn.ts` (no new dependency).

**Indeterminate progress keyframe** added to `src/index.css` (`@keyframes progress-indeterminate`).

**Implementation notes:**
- `Modal` uses `<dialog open>` (not `showModal()`) — focus trap and Esc are handled in
  React. The native top-layer API is not used, but browser back-button and screen reader
  dialog role work correctly.
- `Tooltip` shows on keyboard focus only when wrapping a focusable child (e.g. `Button`).
  Wrapping plain text/icons gives hover-only.
- Gallery page (`src/pages/GalleryPage.tsx`, route `/dev/ui`) was built for visual
  verification and **must be deleted** (along with its route in `App.tsx`) before the
  Phase 2 PR merges.

**How to test manually:**
1. `cd frontend && npm run dev` (no backend needed for Phase 2).
2. Visit [http://localhost:5173/dev/ui](http://localhost:5173/dev/ui).
3. Check each primitive renders in all variants. Key keyboard checks:
   - **Modal**: click "Open modal" → Tab cycles within dialog; Shift+Tab wraps; Esc closes;
     click outside the card closes; focus returns to trigger.
   - **Tabs**: Arrow Right/Left moves between tabs without leaving the tab list.
   - **Tooltip**: Tab to "Hover or focus" button → tooltip appears; Tab away → hides.
   - **Toast**: click "Show toast" → banner appears bottom-right, auto-dismisses after ~4s;
     click × to dismiss early.
   - **Slider/RangeSlider**: drag or arrow-key the thumbs; readout updates.
4. `npm run typecheck && npm run build && npx biome check --write src` — all must pass.

## Phase 3 — App shell & landing  *(done)*

**Goal:** the minimal header shell, the landing link-input flow, and the editor's
extraction-progress entry state.

**Built:**

| File | Purpose |
|---|---|
| `src/components/layout/AppShell.tsx` | Full-height flex column: header + full-bleed `<main>` |
| `src/components/layout/AppHeader.tsx` | Wordmark (font-serif) + Arabic (font-arabic-display) + "New" button |
| `src/components/JobProgress.tsx` | Renders both yt-dlp and `{ stage, status }` progress shapes |
| `src/lib/youtube.ts` | `isLikelyYouTubeUrl()` — loose regex accepting watch/shorts/live/youtu.be |
| `src/pages/LandingPage.tsx` | Rewritten: `Card` + `Input` + `Button`; validate, mutate, navigate |
| `src/pages/EditorPage.tsx` | Extraction entry state machine (see below) |

**Editor entry state machine** (component-local state, no Zustand yet):

```
router state present?
  yes → poll job
         job pending/running  → <JobProgress title="Extracting audio…" />
         job failed           → <Alert variant="error"> + Retry (re-POSTs /projects, replaces route)
         job succeeded        → enable useProject
  no  → enable useProject immediately

useProject loading   → <LoadingSpinner />
useProject 404       → <EmptyState> + "Back to start" link
useProject error     → <Alert variant="error">
useProject success   → ready placeholder (Phase 4 fills this)
```

**Retry model:** the submitted URL is carried in router state (`{ jobId, url }`). On
failure, "Try again" re-POSTs `POST /projects` with the same URL and navigates to the
new `project_id` with `replace: true`. If no URL is available (deep-link entry), the
button says "Back to start" and navigates to `/`.

**Refresh / deep-link:** no sessionStorage; a bare `/p/:id` load attempts `useProject`
directly. 404 → `EmptyState`; 200 → ready.

**How to test manually:**

**Setup** (two terminals):
```sh
# terminal 1
uvicorn sawt_sakinah.service.app:app --reload
# terminal 2
cd frontend && npm run dev
```

**Happy path:**
1. Open [http://localhost:5173](http://localhost:5173).
2. Paste a real YouTube link (short video recommended — test with a ~2 min recitation).
3. Click **Start** → button shows spinner while `POST /projects` resolves.
4. Page transitions to `/p/<id>` — you see the extraction progress bar updating.
5. Once done, page shows the ready placeholder with the video title.

**Validation:**
- Submit an empty field → button is disabled (never submits).
- Type a non-URL string, then click outside → inline hint "That doesn't look like a YouTube link." appears; form won't submit.
- Type `youtube.com/watch?v=abc123` (no protocol) → accepted by the loose check (backend validates for real).

**Failure / retry:**
- Submit a private or deleted video URL → extraction job fails → error `Alert` appears with
  the appropriate message and a **Try again** button. Click it → re-POSTs, navigates to a
  fresh project.

**Refresh states:**
- Mid-extraction refresh (clear router state by navigating to the URL directly) → `EmptyState`
  ("Nothing here yet") with a "Back to start" link.
- Refresh a succeeded project URL → loads the ready placeholder directly (no progress bar).

**Header:**
- "New" button appears on both Landing and Editor; click it → navigates to `/` (no confirm needed).

**References:** [01-layout-and-pages.md](01-layout-and-pages.md),
[05-state-and-api-integration.md](05-state-and-api-integration.md); error status table in
[app.py](../../sawt_sakinah/service/app.py).

## Phase 4 — Waveform & transport  *(done)*

**Goal:** render the track as an interactive waveform and provide transport; this is the
substrate Phases 5-6 draw onto.

**Built:**

| File | Purpose |
|---|---|
| `src/lib/themeColors.ts` | Hex mirrors of `--waveform-*`/`--silence-*`/`--marker-*` CSS vars; canvas can't read custom properties — keep in sync with `index.css` |
| `src/lib/time.ts` | `formatClock(seconds)` -> `"m:ss"` shared by transport readout and wavesurfer plugin labels |
| `src/features/waveform/peaks.ts` | `toWavesurferPeaks(WaveformPeaks)` -> `[max[], min[]]`; wavesurfer v7's bar renderer reads `channelData[0]` as top envelope and `channelData[1]` (via `Math.abs`) as bottom, so this gives the true min/max shape with no normalization (PCM is already `[-1,1]`); falls back to `[max[]]` on length mismatch |
| `src/features/waveform/useWavesurfer.ts` | Lifecycle hook: instance in `useRef` (never state), create/destroy in one effect (StrictMode-safe; swallows `AbortError` on mid-load destroy); Timeline + Hover plugins; events → `playbackStore`; rate and zoom applied via two separate effects so they don't re-trigger init |
| `src/features/waveform/WaveformContext.tsx` | `WaveformProvider` + `useWaveformContext`: React context exposing the instance, container ref, and load state to transport and future phases — chosen over a store ref (more idiomatic) and prop-drilling (would get noisy) |
| `src/features/waveform/WaveformView.tsx` | Container `<div>` with load/error overlays; `relative` so Phase 5/6 overlays can anchor absolutely |
| `src/features/transport/transportControls.ts` | `togglePlay`, `zoomIn`, `zoomOut` — shared by bar buttons and keyboard handler |
| `src/features/transport/useTransportHotkeys.ts` | Space = play/pause, `[`/`]` = zoom; skipped when target is input/textarea/select/contenteditable |
| `src/features/transport/TransportBar.tsx` | Split into `TimeReadout` (subscribes `currentTime`+`duration` only), `PlayButton` (subscribes `isPlaying` only), `ZoomControls`, `RateSelect` — so per-frame time updates re-render only the readout node, not the bar or editor tree |
| `src/stores/playbackStore.ts` | `currentTime`/`duration`/`isPlaying`/`rate`/`zoom` (minPxPerSec); fed from wavesurfer events; selector-subscribe to isolate per-frame renders; `reset()` on teardown |
| `src/pages/EditorPage.tsx` | "Ready" placeholder replaced with `EditorWorkspace` → `WaveformProvider` → `EditorBody` (title + `WaveformView` + `TransportBar`); entry-state machine above is unchanged |

**Design decisions recorded:**
- **Peaks shape:** `[max, min]` (not max-only fallback) — v7 renderer confirmed via source inspection to use `Math.abs` on both channels.
- **Instance access:** React context (`WaveformProvider`) — not a store ref, not prop-drilling.
- **Plugins included:** Timeline axis (helps navigate multi-minute prayers) + Hover cursor tooltip. Both ship inside `wavesurfer.js/dist/plugins`; no new dependency.
- **Playback rate:** `preservePitch: true` so faster review doesn't shift the reciter's pitch.
- **Zoom baseline:** on `ready`, the fitted `clientWidth/duration` is stored in `playbackStore.zoom` as the initial `minPxPerSec`, giving the zoom ±controls a numeric starting point.

**Backend fix (same PR):** [media.py](../../sawt_sakinah/service/routes/media.py)
`get_waveform` now writes the peaks cache via `_cache_peaks()` — uses `tempfile.mkstemp`
(unique name, no concurrent collision) and retries `os.replace` up to 5× with 0.1 s
backoff to tolerate Windows antivirus locks (WinError 32). Cache failure is best-effort;
the computed peaks are always returned.

**References:** [02-waveform-and-playback.md](02-waveform-and-playback.md);
[waveform.py](../../sawt_sakinah/service/waveform.py).

## Phase B — Backend marker layer  *(done)*

**Goal:** the two backend changes Phases 6-7 depend on — persist/edit markers and embed
them on export. Small additions following the `put_edl` / `render` patterns.

- **`PUT /projects/{id}/markers`** in
  [routes/projects.py](../../sawt_sakinah/service/routes/projects.py): accepts a
  `MarkersUpdate` (`{ markers[] }`), replaces `p.markers`, re-derives structure via
  `derive_structure(markers, total_duration=...)`, sets `status.analyzed = True`, and
  returns the full `ProjectView` so the client patches markers + structure in one shot.
  `MarkersUpdate` added to [schemas.py](../../sawt_sakinah/service/schemas.py).
- **Export embeds real marker labels:** `_chapter_lines` /`render` /`_render` in
  [editing/render.py](../../sawt_sakinah/editing/render.py) take an optional
  `chapter_markers: (time, label)[]`; `export_worker`
  ([workers.py](../../sawt_sakinah/service/workers.py)) passes the project's markers when
  `embed_markers` is set. Times are remapped through the kept timeline (markers inside cuts
  drop out); the EDL stays a pure cut/keep/fade record. Falls back to the old EDL-`marker`-op
  chapters when no markers are supplied.
- **Out of scope (confirmed):** no `references`/embeddings work; no standalone
  structure-edit endpoint (structure is always *derived* — the user corrects it by editing
  the boundary markers); no EDL validation hardening or edit-preview render.

## Phase 5 — Silence editing  *(done)*

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

## Phase 6 — Markers & prayer structure  *(done)*

**Goal:** surface detected takbirs/phrases as timeline markers, render the rak'ah/position
outline, and let the user navigate **and correct** it with persisted edits.

**Built:** `src/features/markers/` — `MarkerLayer.tsx`, `MarkerChip.tsx`,
`MarkerControls.tsx` (detect-phrases trigger + progress), `MarkerEditor.tsx`,
`PrayerStructurePanel.tsx`, `MarkersPanel.tsx` (composes the three), `edits.ts` (pure
marker mutations), `structure.ts` (active-position selector), `useMarkerLayout.ts`
(`time -> x` under zoom/scroll); a Zustand `src/stores/markerStore.ts` (selection only).
API glue: `MarkersUpdate` in `types/api.ts`, `updateMarkers` in `endpoints.ts`,
`useUpdateMarkers` in `hooks.ts` (patches the cached `ProjectView` with the returned
markers + structure). `WaveformView` gained an `overlay` slot anchored to the waveform box.

**Design (as built):**
- **Markers:** a vertical line + `Badge`-styled chip per `Marker`, positioned by
  `time -> x`. `useMarkerLayout` reads the rendered `pxPerSec` (wrapper `scrollWidth /
  duration`, the ground truth even when fitted) and scroll offset, recomputing on
  zoom/scroll/resize. Color by `type` via `badgeVariantForMarker`; low-confidence **auto**
  markers dim + dash. Arabic labels use `font-arabic` + `lang="ar" dir="rtl"`. Click a chip
  -> select + seek.
- **Editing (persisted, not a client overlay):** every edit computes the next `Marker[]`
  (`edits.ts`) and calls `useUpdateMarkers`; the server replaces the list, **re-derives
  structure**, and returns both. Add-at-playhead, relabel, retype, move-to-playhead, and
  delete are in `MarkerEditor`. User markers carry `source: "user"`; new markers leave `id`
  blank so the backend derives the canonical `type-time` id. **Structure is never edited
  directly** — the user corrects it by editing the boundary markers, which re-derives it.
- **Prayer panel:** group `PrayerPosition[]` by `rakah`; click a position -> seek; the
  active position highlights as `currentTime` advances (a zustand selector maps the playhead
  to the active index, so the panel re-renders only when the index changes). A gentle
  `warning` `Alert` flags an incomplete-looking outline (no advancing markers / no tasleem);
  never a hard error — recitations vary.
- **Timeline invariant (resolves the old open question):** the frontend works entirely on
  the **original source timeline**; there is no edit preview. Cuts are applied and marker
  times remapped **only at export, server-side** (`_remap_time`). The waveform, silences,
  markers, and structure all stay on the original timeline — the frontend never remaps time.
- **Dropped from v1:** the reference-clip "Use as reference" affordance (the `references`
  payload is inert on the Whisper backend).

**References:** [04-markers-and-prayer-structure.md](04-markers-and-prayer-structure.md);
[audio/03-phrase-detection.md](../audio/03-phrase-detection.md);
[markers.py](../../sawt_sakinah/models/markers.py) (`Marker.id` is derived from
`type`+`time`; `duration` is computed; `source` is `auto|user`),
[structure.py](../../sawt_sakinah/models/structure.py); `PhraseParams`/`PhraseRequest` in
[schemas.py](../../sawt_sakinah/service/schemas.py). Note Whisper detection is **slow**
and runs on a single-worker pool (`phrase_workers: 1`) — expect a long poll.

## Phase 7 — Export + backend static mount + desktop  *(done)*

**Goal:** the export flow, plus serving the SPA from FastAPI and a native desktop window.

**Built (frontend):** `src/features/export/` — `ExportButton.tsx` (opens the modal; mounts
it only while open so no job polls after close) and `ExportModal.tsx` (`format` / `bitrate`
/ `embed_markers` -> `ExportRequest`; `useExport` -> poll job -> on success read the
artifact id from the job result and offer `exportDownloadUrl` as a native download link).
Wired into the editor header beside the title. Because Phase B sources export chapters from
`project.markers`, whatever the user has after Phase 6 edits is exactly what `embed_markers`
embeds — no extra bridging.

**Built (backend static mount):** `_mount_spa` in
[app.py](../../sawt_sakinah/service/app.py) runs after `include_router`, so API routes win.
Hashed assets are served by `StaticFiles` at `/assets`; a `GET /{full_path:path}` catch-all
serves a real file when one exists (favicon, etc.) or `index.html` otherwise, so React
Router deep links like `/p/<id>` resolve. Mounted only when the built dir exists
(`ServiceSettings.static_dir`, default `frontend/dist`, override `SAWT_STATIC_DIR`), so dev
(Vite proxy) is untouched. Path traversal outside the dir falls back to the shell. Same
origin, so no CORS.

**Built (desktop shell):** [sawt_sakinah/desktop.py](../../sawt_sakinah/desktop.py) runs the
same app on a background uvicorn thread, waits for it to accept connections, then opens a
pywebview window at the local URL; closing the window stops the server. It requires the
built SPA (errors clearly if missing). pywebview is an optional extra
(`[project.optional-dependencies] desktop`) in
[pyproject.toml](../../pyproject.toml), kept out of `all` so headless installs stay GUI-free.
Reachable as `python -m sawt_sakinah desktop`, `python -m sawt_sakinah.desktop`, or
`make desktop` (which builds the SPA first). `make requirements-desktop` installs the extra.

**References:** shell section of [00-overview.md](00-overview.md);
[audio/04-editing-and-export.md](../audio/04-editing-and-export.md);
[export.py](../../sawt_sakinah/service/routes/export.py) and `export_worker` in
[workers.py](../../sawt_sakinah/service/workers.py) (returns `{ artifact_id }`);
`ExportRequest`/`ExportArtifactView` in
[schemas.py](../../sawt_sakinah/service/schemas.py). `embed_markers` default is `true`
(`CONFIG.editing` in [defaults.yaml](../../sawt_sakinah/config/defaults.yaml)).
