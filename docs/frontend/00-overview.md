# Frontend — Architecture Overview

> Status: implemented. Defines the vision, the stack as built, the design tokens
> inherited from `the base theme`, and how the UI talks to the audio engine.

## Vision

A single-purpose audio editor for Quran recitation:

1. Paste a YouTube link → the audio is extracted to MP3 (backend job, with progress).
2. The audio renders as an interactive **waveform** with play / pause / seek.
3. **Silent regions** are highlighted on the waveform for easy identification; the user
   selects them and can **cut / remove / save**.
4. **Takbir markers** ("Allahu Akbar") and other detected phrases appear on the
   timeline, labeling **rak'ah and prayer positions** (qiyam, ruku', sujood, ...).

The frontend is a **view + control surface** over the audio engine. All heavy lifting
(extraction, detection, rendering edits) happens in the Python backend; the UI consumes
structured data and posts user decisions back. See [../audio/](../audio/) for the engine
and [../audio/05-data-model-and-api.md](../audio/05-data-model-and-api.md) for the API.

## Stack

The app borrows `the base theme`'s **aesthetic** (palette, type, spacing, shape) but not its
tech stack — that is purely CSS and is portable to any web frontend. The app is a
**locally run interactive editor** over a Python audio engine, which drives these choices:

- **Framework:** React 18 + **TypeScript**.
- **Build:** Vite. The frontend builds to static assets.
- **Shell:** the built SPA is **served by the Python backend (FastAPI)** and opened in a
  **pywebview** native window. Develop against `localhost` in a browser first (fastest
  loop, identical app); point pywebview at the same URL when a real app window is wanted.
  One Python process serves everything; there is no separate Node runtime at run time.
- **Routing:** React Router.
- **Styling:** Tailwind CSS 3 + **CSS custom properties** for all design tokens
  (`src/index.css`). Utility-first classes plus component classes (`.btn-*`, `.card-*`).
- **Data layer:** `@tanstack/react-query` for async fetching, caching, and job polling.
- **Editor state:** Zustand stores (`src/stores/`) for selection, playhead, zoom, and the
  in-progress edit list; server data stays in the React Query cache.
- **Waveform:** wavesurfer.js v7, wrapped in `src/features/waveform/`.
- **Components:** a **custom UI library** in `src/components/ui/` (no shadcn/Radix/MUI).
  The primitives — `Button`, `Card`, `Input`, `Modal`, `Badge`, `Progress`, `Slider`,
  `Tooltip`, `LoadingSpinner` — are React components styled to the base theme's tokens.
- **Lint/format:** Biome (as in the base theme).

> the base theme's `index.css`, `tailwind.config.js`, and `/public/fonts/` assets were copied
> verbatim to lock in theme parity; the UI primitives were rebuilt in React on top of those
> tokens, and the waveform editor sits on top of the primitives. Only the design tokens and
> Tailwind config carry over from the base theme — none of its component code does.

## Design tokens (`frontend/src/index.css`, mapped 1:1 into Tailwind)

Light mode only. Warm cream paper tiled with an ogee lattice, deep purple accent, slate
text. The token structure is inherited from the base theme; the accent was remapped from
burgundy to purple.

```
Background     --color-background            #fcfbf8
  secondary    --color-background-secondary  #f4f3ef
  tertiary     --color-background-tertiary   #ecebe6
Text           --color-text                  #334155
  secondary    --color-text-secondary        #475569
  tertiary     --color-text-tertiary         #64748b
Accent         --color-accent                #450377
  hover        --color-accent-hover          #38025f
  secondary    --color-accent-secondary      #9667ba
  soft         --color-accent-soft           rgba(69,3,119,0.10)
Border         --color-border                #e0e0e0
  focus        --color-border-focus          #450377
Semantic       error #ef4444  success #22c55e  warning #f59e0b  info #3b82f6
Glass          rgba(252,251,248,0.92), blur(20px)
```

Typography: **Ibarra Real Nova** (serif) for H1 and main headings; **Futura** for body;
**Amiri** and **IBM Plex Sans Arabic** for Arabic (applied via `:lang(ar)`). All faces
are self-hosted `@font-face` declarations with system fallbacks, because the desktop
shell's content policy blocks CDN fetches.

Shape & motion: radius ~10px (buttons/inputs), 12–16px (cards/panels); shadows
`--shadow-xs..2xl`; durations `--duration-fast 150ms` / `normal 250ms`; easings
`--ease-out`, `--ease-spring`.

### Waveform palette

```
Waveform (played)          --waveform-played     accent
Waveform (unplayed)        --waveform-unplayed   #cbd5e1
Silence region fill        --silence-fill        rgba(150,103,186,0.18); selected 0.38
Cut region fill            --cut-fill            rgba(239,68,68,0.20);   selected 0.40
Range selection            --selection-fill      rgba(245,158,11,0.30)
Marker line                --marker-line         accent
Position label             cream chip with slate text (Badge variants)
```

## UX flow

```
[ Link input ]  ->  [ Extracting... progress ]  ->  [ Editor ]
                                                       |- waveform + transport
                                                       |- silence panel (list + bulk actions)
                                                       |- markers / prayer-structure panel
                                                       |- export
```

## Documents in this set

- [01-layout-and-pages.md](01-layout-and-pages.md) — app shell, routes, editor layout.
- [02-waveform-and-playback.md](02-waveform-and-playback.md) — waveform render + transport.
- [03-silence-editing-ui.md](03-silence-editing-ui.md) — highlight, select, cut, save.
- [04-markers-and-prayer-structure.md](04-markers-and-prayer-structure.md) — takbirs & positions.
- [05-state-and-api-integration.md](05-state-and-api-integration.md) — query, stores, jobs.
