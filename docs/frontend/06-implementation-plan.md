# Implementation Plan

> Status: implemented; retained as the build record. The build plan for the Sawt Sakinah frontend, written so any agent can
> pick up a phase and execute it without re-deriving context. Phases 0-7 are **done**
> (code in `frontend/`), plus a small backend phase (Phase B). Where the planning docs
> (00-05) and the live backend disagree, **the backend wins** — deltas are tabulated.
>
> Phases B and 6 are superseded by the **Surah view** (surah recognition, the surah band
> and the Surahs column; see [04-surah-view.md](04-surah-view.md)) and keep only a short
> note. The orientation, contract and file map below describe the code as it is now.

## Orientation

Sawt Sakinah is a single-purpose audio editor for Quran recitation: paste a YouTube link,
the backend extracts the audio, the UI renders an interactive waveform, the user removes
silent gaps and finds which surahs are recited (keeping or splitting off a surah), then
exports. The
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

- **Theme:** "Mushaf × Mihrab", one layout by day and by night. Accent oxblood `#6A1E28`
  by day, gold `#C9AA66` at night. See [Theme tokens](#theme-tokens).
- **Arabic type:** Amiri (logo + headings, echoes Ibarra Real Nova) + IBM Plex Sans
  Arabic (UI labels, echoes Jost).
- **Shell:** the library under the Sanctuary dome (`LibraryShell`); the editor beside an
  88 px binding rail (`EditorShell`).
- **Scope (v1):** a single in-flight recording (link input -> `/p/:projectId` editor ->
  export). The library of recordings (`GET /projects`) is covered by
  [frontend-project-library-plan.md](../plans/frontend-project-library-plan.md).

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
- **Waveform regions and overlays are a projection of app state**, reconciled in effects
  keyed on the silence and cut lists (regions) or rendered from the project (the surah
  band and tints) — not their own source of truth.
- **Styling:** only the tokens below; no hex in components. Selected = accent;
  destructive = `danger` (the error token).
- **Errors:** the client throws a typed [`ApiError`](../../frontend/src/api/client.ts)
  (`status`, `type`); surface via `Alert`/`Toast`, with retry tied to the originating job.

## Backend reality vs. planning docs (build against the code)

| Planning doc said | Live backend (authoritative) | File |
|---|---|---|
| Job state `done`/`failed` | `pending \| running \| succeeded \| failed` | [jobs.py](../../sawt_sakinah/service/jobs.py) |
| `progress` is a number | arbitrary **dict** per job kind | [jobs.py](../../sawt_sakinah/service/jobs.py) / [workers.py](../../sawt_sakinah/service/workers.py) |
| waveform returns "peaks" | `{version, sample_rate, rate, buckets, duration_sec, scale_db, levels}` | [waveform.py](../../sawt_sakinah/service/waveform.py) |
| generic routes | mounted at **root** (`/projects`, `/jobs`), no `/api`; writes return `202` | [app.py](../../sawt_sakinah/service/app.py) |
| FastAPI serves the SPA | **wired** (Phase 7): SPA served at `/` with a deep-link catch-all when `frontend/dist` exists; API routes take precedence; still no CORS | [app.py](../../sawt_sakinah/service/app.py) |
| `SilenceSegment.mean_db` | optional; `duration` is a computed field (present in JSON) | [segments.py](../../sawt_sakinah/models/segments.py) |
| analysis beyond silence | surah recognition: `POST /projects/{id}/detect/surahs` fills `Project.surahs`, which is read-only (re-run, never edited) | [routes/projects.py](../../sawt_sakinah/service/routes/projects.py) |

The SPA-serving row is resolved by Phase 7.

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
POST /projects/{id}/detect/surahs        SurahRequest         -> 202 { job_id }   # 409 without the model
GET  /quran/surahs                       -> SurahInfo[]
PUT  /projects/{id}/edl                  { operations[] }     -> EditDecisionList
POST /projects/{id}/export               ExportRequest        -> 202 { job_id }   # embed_chapters
POST /projects/{id}/split                { ranges, name? }    -> 202 { project_id, job_id }
GET  /projects/{id}/audio                -> audio stream (HTTP range)
GET  /projects/{id}/waveform             -> WaveformPeaks
GET  /projects/{id}/exports/{artifactId} -> file download
```

Wire shapes mirror the pydantic models exactly
([schemas.py](../../sawt_sakinah/service/schemas.py),
[models/](../../sawt_sakinah/models/)): `ProjectView`, `AudioSourceView`,
`SilenceSegment`, `SurahMap`/`SurahPassage`, `EditOperation` (`cut|keep|fade`),
`EditDecisionList`, `ExportArtifactView`, `JobRecord`
(`kind: extract|detect_silence|detect_surahs|export|split|download_model|...`). Sync failures return
`{ error, detail }` with a typed status (400/403/404/422/451/502, table in
[app.py](../../sawt_sakinah/service/app.py)); async failures surface in
`JobRecord.error` / `error_type`.

**Timeline invariant:** the editor works entirely on the original source timeline: the
EDL, silences, surah passages and cut authoring are all source seconds. The waveform only
presents a collapsed view through a `TimeMap` (`features/waveform/timeMap.ts`); there is no
audio edit preview, and cuts are applied and times remapped (`_remap_time`) only at export,
server-side.

### Jobs are the async backbone

Extraction, both detections, and export return `202 { job_id }`. Poll
`GET /jobs/{id}` until `state` is `succeeded`/`failed`, then refetch the affected
project. This is already implemented as [`useJob`](../../frontend/src/api/hooks.ts)
(stops polling on settle; pass `invalidateProject: true` to refetch the project on
success) and the [`jobToViewState`](../../frontend/src/api/viewState.ts) mapper
(`extracting | analyzing | exporting | ready | error`). Progress payloads:

- **extraction** — the yt-dlp hook dict (`status`, `downloaded_bytes`, `total_bytes`,
  `eta`, ...).
- **silence / surahs / export** — `{ stage, status }` (see the `*_worker` functions in
  [workers.py](../../sawt_sakinah/service/workers.py)); surah matching also reports
  `{ stage: "transcribing", done_sec, total_sec }` and then `{ stage: "matching" }`.

## Current frontend file map (the core from Phases 0-4)

```
frontend/
  vite.config.ts            dev server + /projects,/jobs proxy
  tailwind.config.js        token-bound theme (colors/fonts/radius/shadow)
  tsconfig.json  biome.json  package.json
  index.html
  public/fonts/README.md    which .woff2 files to drop in
  src/
    main.tsx                React root: QueryClientProvider + BrowserRouter
    App.tsx                 routes: /, /new and /p/:projectId
    index.css               imports the tokens; @font-face, base styles, loader keyframes
    theme/
      tokens.css            design tokens: day on :root, night under [data-theme="night"]
      theme.ts              system/day/night preference -> data-theme on <html>
    pages/
      ProjectLibraryPage.tsx  the library ("Your recordings"); /new opens the
                            New recording sheet over it
      EditorPage.tsx        entry state machine + EditorWorkspace (the ruled page)
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
      themeColors.ts        resolves the waveform/region tokens for the canvas
                            (getComputedStyle), re-read when the theme changes
      time.ts               formatClock(seconds) -> "m:ss"
    components/
      ui/                   Button, SegmentedControl, Tabs, Badge, Modal/SimpleModal,
                            Alert, Toast, Tooltip, Slider, Input, Progress, EmptyState,
                            WaveformLoader
      layout/               AppShell, LibraryShell (Sanctuary), EditorShell (binding rail)
      ornament/             React wrappers over src/ornament geometry (niche, cartouche,
                            dome, lattice, Rub el Hizb star, ribbon tab, logo)
      JobProgress.tsx       yt-dlp + {stage,status} progress shapes
    ornament/               pure geometry builders (no React, no colours)
    features/
      waveform/
        editedPeaks.ts      decodeWaveform + sliceEditedPeaks: source levels -> rendered levels
        useWaveformEngine.ts  wavesurfer as renderer + an owned <audio> for playback;
                            Minimap overview, Timeline + Hover plugins; events -> playbackStore
        WaveformContext.tsx WaveformProvider + useWaveformContext (React context, not store ref)
        WaveformView.tsx    container div + load/error overlays
        WaveformOverview.tsx  whole-recording strip with the visible range and zoom
        PlayheadDiamond.tsx the playhead's diamond on the top rule
      transport/
        transportControls.ts  togglePlay / seekBy / zoomIn / zoomOut (shared by bar + hotkeys)
        useTransportHotkeys.ts  Space=play/pause, ArrowLeft/ArrowRight=skip 5 s; ignored in
                            form fields
        TransportBar.tsx    split subcomponents (Clock subscribes currentTime alone,
                            PlayButton subscribes isPlaying alone) to isolate per-frame renders
      landing/              Sanctuary: dome landing and the library header
      projects/             NicheCard, FihristList, ProjectMenu, NewRecordingSheet,
                            ImportAnywhere, RenameDialog, DeleteDialog, ProjectSwitcher
      editor/               RuledPage, LowerBand (Silence/Cut tabs + the Surahs column)
      surahs/               surah band and tints, Surahs column, matching (see 04-surah-view.md)
    stores/
      playbackStore.ts      currentTime/duration/isPlaying/rate/zoom; fed from wavesurfer events;
                            selector-subscribe to avoid full-tree re-renders per frame
```

Suggested places for new code (keep features cohesive): UI primitives in
`src/components/ui/`, layout in `src/components/layout/`, feature modules in
`src/features/<feature>/`, Zustand stores in `src/stores/`, shared helpers in `src/lib/`.

## Theme tokens

Defined in [src/theme/tokens.css](../../frontend/src/theme/tokens.css), day values on
`:root` and night values under `:root[data-theme="night"]`, and bound by name to Tailwind
utilities in [tailwind.config.js](../../frontend/tailwind.config.js) (`bg-accent`,
`text-accent`, `bg-surface`, `border-focus`, `bg-dome`, etc.).
[src/theme/theme.ts](../../frontend/src/theme/theme.ts) applies the stored preference
(`system` | `day` | `night`). Text on accent fills uses `--color-on-accent`; gold
(`--color-gold`) is for rules, ornament and display text of 24px and up, never small body
text. Backgrounds, text, and semantic colours (error/success/warning) are listed in
[00-overview.md](00-overview.md); the accent tokens (day / night) are:

```
--color-accent        #6A1E28 / #C9AA66   primary actions; played waveform; active states; focus ring
--color-accent-hover  #4F161D / #DCC791   button hover / active
--color-accent-soft   accent at 7% / 16%  subtle backgrounds; info alerts
--color-on-accent     #FBF8F1 / #2A1E20   text on accent fills
--waveform-* / --silence-fill* / --cut-stripe* / --selection-fill   waveform and region tokens
--surah-wash-{a,b,f,sel} / --surah-ink-{a,b,f,sel}                surah tones (band, tints)
```

## Fonts

Self-hosted under [frontend/public/fonts/](../../frontend/public/fonts/) (the
static-served / pywebview build runs under a CSP that forbids CDN fetches). Tailwind
families: `serif`->Ibarra Real Nova, `sans`->Jost, `arabic-display`->Amiri,
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
| `Button` | `Button.tsx` | variants primary/secondary/ghost/danger/dome, sizes sm/md/icon, `loading` spinner |
| `SegmentedControl` | `SegmentedControl.tsx` | mutually exclusive toggle buttons on a sunk track; chosen segment fills with the accent |
| `Input` | `Input.tsx` | forwardRef, `invalid` + hint, `useId` for label pairing |
| `Modal` + `SimpleModal` + `ModalTitle` | `Modal.tsx` | native `<dialog open>`, focus trap, Esc + scrim close; one title bar for every dialog |
| `Badge` | `Badge.tsx` | neutral / green variants |
| `Progress` | `Progress.tsx` | determinate (value 0–1, `role="progressbar"`) or an indeterminate `WaveformLoader` |
| `Slider` | `Slider.tsx` | native range input; accent-filled track and a diamond thumb |
| `Tooltip` | `Tooltip.tsx` | hover + focus (bubbles from focusable child); CSS-positioned |
| `WaveformLoader` | `WaveformLoader.tsx` | bars drawing in and out in `currentColor`; static under `prefers-reduced-motion` |
| `Tabs` | `Tabs.tsx` | roving tabIndex; Arrow/Home/End; controlled + uncontrolled |
| `ToastProvider` + `useToast` | `Toast.tsx` | context provider; auto-dismiss; `<output>` items |
| `EmptyState` | `EmptyState.tsx` | icon slot, title, description, optional action |
| `Alert` | `Alert.tsx` | error/success/warning/info (info takes the accent); optional retry action button |

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
     click the scrim closes; focus returns to trigger.
   - **Tabs**: Arrow Right/Left moves between tabs without leaving the tab list.
   - **Tooltip**: Tab to "Hover or focus" button → tooltip appears; Tab away → hides.
   - **Toast**: click "Show toast" → banner appears bottom-right, auto-dismisses after ~4s;
     click × to dismiss early.
   - **Slider**: drag or arrow-key the thumb; readout updates.
4. `npm run typecheck && npm run build && npx biome check --write src` — all must pass.

## Phase 3 — App shell & landing  *(done)*

**Goal:** the app shell, the new-recording link-input flow, and the editor's
extraction-progress entry state.

**Built:**

| File | Purpose |
|---|---|
| `src/components/layout/AppShell.tsx` | Picks the layout by route: `EditorShell` for `/p/:projectId`, `LibraryShell` otherwise |
| `src/components/layout/LibraryShell.tsx` | The Sanctuary: dome landing on a cold launch, then the library header (logo, lamp ring, theme switch, settings) |
| `src/components/layout/EditorShell.tsx` | 88 px binding rail: app mark (home), Library, New recording, theme switch, settings |
| `src/components/JobProgress.tsx` | Renders both yt-dlp and `{ stage, status }` progress shapes |
| `src/lib/youtube.ts` | `isLikelyYouTubeUrl()` — loose regex accepting watch/shorts/live/youtu.be |
| `src/features/projects/NewRecordingSheet.tsx` | The New recording sheet over the library (`/new`): link field + file drop zone; validate, mutate, navigate |
| `src/pages/EditorPage.tsx` | Extraction entry state machine (see below) |

**Editor entry state machine** (component-local state, no Zustand yet):

```
router state present?
  yes → poll job
         job pending/running  → <JobProgress title="Extracting audio…" />
         job failed           → <Alert variant="error"> + Retry (re-POSTs /projects, replaces route)
         job succeeded        → enable useProject
  no  → enable useProject immediately

useProject loading   → <WaveformLoader />
useProject 404       → <EmptyState> + "Back to library" action
useProject error     → <Alert variant="error">
useProject success   → ready placeholder (Phase 4 fills this)
```

**Retry model:** the submitted URL is carried in router state (`{ jobId, url }`). On
failure, "Try again" re-POSTs `POST /projects` with the same URL and navigates to the
new `project_id` with `replace: true`. If no URL is available (deep-link entry), the
button says "Back to start" and navigates to `/new`.

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
1. Open [http://localhost:5173](http://localhost:5173) and choose **New recording**.
2. Paste a real YouTube link (short video recommended — test with a ~2 min recitation).
3. Press **Enter** → the import starts while `POST /projects` resolves.
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
  ("Nothing here yet") with a "Back to library" action.
- Refresh a succeeded project URL → loads the ready placeholder directly (no progress bar).

**New recording:**
- The library's New recording button and the editor rail's + both navigate to `/new`,
  which opens the sheet over the library (no confirm needed).

**References:** [01-layout-and-pages.md](01-layout-and-pages.md),
[05-state-and-api-integration.md](05-state-and-api-integration.md); error status table in
[app.py](../../sawt_sakinah/service/app.py).

## Phase 4 — Waveform & transport  *(done)*

**Goal:** render the track as an interactive waveform and provide transport; this is the
substrate Phases 5-6 draw onto.

**Built:**

| File | Purpose |
|---|---|
| `src/lib/themeColors.ts` | Resolves the `--waveform-*`/`--silence-*`/`--selection-fill` tokens with `getComputedStyle` for the canvas; re-read when the resolved theme changes |
| `src/lib/time.ts` | `formatClock(seconds)` -> `"m:ss"` shared by transport readout and wavesurfer plugin labels |
| `src/features/waveform/editedPeaks.ts` | `decodeWaveform(WaveformPeaks)` -> `0..1` RMS levels already scaled to the recording; `sliceEditedPeaks` resamples them onto the edited timeline from exact span boundaries; wavesurfer draws one channel mirrored, with `normalize: false` |
| `src/features/waveform/useWaveformEngine.ts` | Lifecycle hook: instance in `useRef` (never state), create/destroy in one effect (StrictMode-safe); wavesurfer renders from peaks while an owned `<audio>` plays the source; Minimap overview, Timeline + Hover plugins; events → `playbackStore`; rate and zoom applied via separate effects so they don't re-trigger init |
| `src/features/waveform/WaveformContext.tsx` | `WaveformProvider` + `useWaveformContext`: React context exposing the instance, container ref, and load state to transport and future phases — chosen over a store ref (more idiomatic) and prop-drilling (would get noisy) |
| `src/features/waveform/WaveformView.tsx` | Container `<div>` with load/error overlays; `relative` so Phase 5/6 overlays can anchor absolutely |
| `src/features/transport/transportControls.ts` | `togglePlay`, `seekBy`, `zoomIn`, `zoomOut` — shared by bar buttons and keyboard handler |
| `src/features/transport/useTransportHotkeys.ts` | Space = play/pause, ArrowLeft/ArrowRight = skip 5 s; skipped when target is input/textarea/select/contenteditable |
| `src/features/transport/TransportBar.tsx` | Split into `Clock` (subscribes `currentTime`+`duration` only), `PlayButton` (subscribes `isPlaying` only), `RateSelect` — so per-frame time updates re-render only the clock node, not the bar or editor tree; zoom sits on the overview |
| `src/stores/playbackStore.ts` | `currentTime`/`duration`/`isPlaying`/`rate`/`zoom` (minPxPerSec); fed from wavesurfer events; selector-subscribe to isolate per-frame renders; `reset()` on teardown |
| `src/pages/EditorPage.tsx` | `EditorWorkspace` → `WaveformProvider` → `EditorBody`: the ruled page with the title cartouche, overview, `WaveformView`, `TransportBar` and lower band; entry-state machine above is unchanged |

**Design decisions recorded:**
- **Peaks shape:** `[max, min]` (not max-only fallback) — v7 renderer confirmed via source inspection to use `Math.abs` on both channels.
- **Instance access:** React context (`WaveformProvider`) — not a store ref, not prop-drilling.
- **Plugins included:** Timeline axis (helps navigate multi-minute recordings) + Hover cursor tooltip. Both ship inside `wavesurfer.js/dist/plugins`; no new dependency.
- **Playback rate:** `preservePitch: true` so faster review doesn't shift the reciter's pitch.
- **Zoom baseline:** on `ready`, the fitted `clientWidth/duration` is stored in `playbackStore.zoom` as the initial `minPxPerSec`, giving the zoom ±controls a numeric starting point.

**Backend fix (same PR):** [media.py](../../sawt_sakinah/service/routes/media.py)
`get_waveform` now writes the peaks cache via `_cache_peaks()` — uses `tempfile.mkstemp`
(unique name, no concurrent collision) and retries `os.replace` up to 5× with 0.1 s
backoff to tolerate Windows antivirus locks (WinError 32). Cache failure is best-effort;
the computed peaks are always returned.

**References:** [02-waveform-and-playback.md](02-waveform-and-playback.md);
[waveform.py](../../sawt_sakinah/service/waveform.py).

## Phase B — Backend marker layer  *(done; superseded)*

Phase B added a backend API for editing detected phrase markers and wrote those markers
as export chapters. Surah recognition replaced it: there is no marker API, and export
writes the accepted surah passages as chapters (`embed_chapters`). See
[04-surah-view.md](04-surah-view.md) and
[audio/04-editing-and-export.md](../audio/04-editing-and-export.md).

## Phase 5 — Silence editing  *(done)*

**Goal:** make silent gaps obvious and let the user remove them with an undoable,
non-destructive EDL, then export.

**Build:** `src/features/silence/` — `SilencePanel.tsx`, `SilenceList.tsx`,
`SilenceControls.tsx`, `regions.ts` (silence keys; drawing lives in
`features/cuts/regions.ts`),
`edl.ts` (UI-action -> op mapping + derive the kept timeline); a Zustand
`src/stores/editStore.ts` (`operations[]`, `undoStack`, `redoStack`, `selectedSilenceIds`).

**Design:**
- **Overlays:** one wavesurfer Regions entry per `SilenceSegment`; fill `--silence-fill`
  (ink at 8%), selected = `--silence-fill-selected` (18%); removed silences and manual
  cuts draw as the `--cut-stripe` 45° hatch with an edge line at each end. Regions are read-only highlights in v1 (no drag);
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
[edl.py](../../sawt_sakinah/models/edl.py) (`EditOperation` is `cut|keep|fade`,
`end` optional); `SilenceParams` in [schemas.py](../../sawt_sakinah/service/schemas.py).

## Phase 6 — Markers & prayer structure  *(done; superseded)*

Phase 6 showed detected phrases as timeline markers with an editor and a prayer outline
beside the tools. The **Surah view** ([04-surah-view.md](04-surah-view.md)) replaced it:
the surah band and tints on the waveform, the Surahs column, and `[` / `]` stepping
through surah passages. Its `time -> x` layout lives on as
`features/waveform/useOverlayLayout.ts`.

## Phase 7 — Export + backend static mount + desktop  *(done)*

**Goal:** the export flow, plus serving the SPA from FastAPI and a native desktop window.

**Built (frontend):** `src/features/export/` — `ExportButton.tsx` (opens the modal; mounts
it only while open so no job polls after close) and `ExportModal.tsx` (`format` / `bitrate`
/ `embed_chapters` -> `ExportRequest`; `useExport` -> poll job -> on success read the
artifact id from the job result and offer `exportDownloadUrl` as a native download link).
Wired into the editor's title row beside the cartouche. "Add surahs as chapters"
(`embed_chapters`) writes the accepted surah passages from `project.surahs` as chapters.

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
[schemas.py](../../sawt_sakinah/service/schemas.py). `embed_chapters` defaults to
`CONFIG.editing.embed_chapters` in [defaults.yaml](../../sawt_sakinah/config/defaults.yaml).
