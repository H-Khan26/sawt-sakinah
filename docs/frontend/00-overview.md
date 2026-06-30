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

## Stack — match `the base theme`

The frontend must visually and technically align with `C:\Users\user\the base theme`:

- **Framework:** Solid JS (`solid-js`, `@solidjs/router`) + **TypeScript**.
- **Build:** Vite. **Desktop shell:** Tauri 2.x (optional for v1; the app can run as a
  plain web app first and adopt Tauri later — confirm with the user).
- **Styling:** Tailwind CSS 3 + **CSS custom properties** for all design tokens
  (`src/index.css`). Utility-first classes plus component classes (`.btn-*`, `.card-*`).
- **Data layer:** `@tanstack/solid-query` for async fetching, caching, and job polling.
- **Components:** a **custom UI library** in `src/components/ui/` (no shadcn/Radix/MUI).
  Reuse the base theme's component patterns and, where practical, port its `Button`, `Card`,
  `Input`, `Modal`, `Badge`, `Progress`, `Slider`, `Tooltip`, `LoadingSpinner`.
- **Lint/format:** Biome (as in the base theme).

> Recommendation for the implementing agent: copy the base theme's `index.css`,
> `tailwind.config.js`, the `/public/fonts/` assets, and the `src/components/ui/`
> primitives as the starting shell, then build the waveform editor on top. This
> guarantees theme parity instead of re-deriving it.

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
