# Frontend — Architecture Overview

> Status: planning. Jumping-off point for an implementing agent. Defines vision, stack,
> design tokens to inherit from `the base theme`, and how the UI talks to the audio engine.

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

Borrow `the base theme`'s **aesthetic** (palette, type, spacing, shape) but not its tech
stack — that is purely CSS and is portable to any web frontend. The app is a **locally
run interactive editor** over a Python audio engine, which drives these choices:

- **Framework:** React 18 + **TypeScript**.
- **Build:** Vite. The frontend builds to static assets.
- **Shell:** the built SPA is **served by the Python backend (FastAPI)** and opened in a
  **pywebview** native window. Develop against `localhost` in a browser first (fastest
  loop, identical app); point pywebview at the same URL when a real app window is wanted.
  No Tauri, no Electron, no Node runtime at runtime — one Python process serves everything.
- **Routing:** React Router.
- **Styling:** Tailwind CSS 3 + **CSS custom properties** for all design tokens
  (`src/index.css`). Utility-first classes plus component classes (`.btn-*`, `.card-*`).
- **Data layer:** `@tanstack/react-query` for async fetching, caching, and job polling.
- **Components:** a **custom UI library** in `src/components/ui/` (no shadcn/Radix/MUI).
  Rebuild the primitives — `Button`, `Card`, `Input`, `Modal`, `Badge`, `Progress`,
  `Slider`, `Tooltip`, `LoadingSpinner` — in React, styled to the base theme's tokens.
- **Lint/format:** Biome (as in the base theme).

> Recommendation for the implementing agent: copy the base theme's `index.css`,
> `tailwind.config.js`, and the `/public/fonts/` assets to lock in theme parity, then
> rebuild the UI primitives in React and build the waveform editor on top. Component
> code does not port from Solid, but the design tokens and Tailwind config do — copy
> those verbatim rather than re-deriving them.

## Design tokens to inherit (from the base theme)

Light mode only. Warm, burgundy-accented aesthetic.

```
Background     --color-background          #fcfbf8  (surface-flat)
  secondary    --color-background-secondary #f4f3ef (cream-2)
  tertiary     --color-background-tertiary  #ecebe6 (cream-3)
Text           --color-text                #334155  (slate-700)
  secondary    --color-text-secondary      #475569  (slate-600)
  tertiary     --color-text-tertiary       #64748b  (slate-500)
Accent         --color-accent              #330403  (burgundy-1)
  hover        --color-accent-hover        #460303  (burgundy-2)
Border         --color-border              #e0e0e0  (grey-2)
  focus        --color-border-focus        #330403  (burgundy-1)
Semantic       error #ef4444  success #22c55e  warning #f59e0b  info #3b82f6
Glass          --color-glass rgba(255,255,255,0.85), blur(20px)
```

Typography: **Ibarra Real Nova** (serif) for H1/logo/main headings; **Futura** for
subheadings and body. Type scale and weights as defined in the base theme's `index.css`
(`--font-size-*`, `--font-weight-*`).

Shape & motion: radius ~10px (buttons/inputs), 12–16px (cards/panels); shadows
`--shadow-xs..2xl`; durations `--duration-fast 150ms` / `normal 250ms`; easings
`--ease-out`, `--ease-spring`.

### Waveform-specific palette (derive from the above)

To keep the audio editor on-brand, map waveform states onto existing tokens:

```
Waveform body (played)     burgundy-1 (#330403)         --color-accent
Waveform body (unplayed)   slate-400 (#94a3b8) / grey   --color-text-tertiary-ish
Progress / cursor          burgundy-1
Silence region fill        red/orange overlay (warning), low alpha for highlight
Silence region (selected)  higher-alpha burgundy or red, with a solid left accent bar
Takbir marker              burgundy vertical line + label chip (Badge styling)
Position label             cream chip with slate text (Badge variants)
```

Confirm exact alphas during implementation; reuse the overlay variables
(`--burgundy-overlay-*`, `--black-overlay-*`) rather than inventing new colors.

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
