# Frontend — Architecture Overview

> Status: implemented. Defines the vision, the stack as built, the design tokens, and
> how the UI talks to the audio engine.

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

The app is a **locally run interactive editor** over a Python audio engine, which drives
these choices:

- **Framework:** React 18 + **TypeScript**.
- **Build:** Vite. The frontend builds to static assets.
- **Shell:** the built SPA is **served by the Python backend (FastAPI)** and opened in a
  **pywebview** native window. Develop against `localhost` in a browser first (fastest
  loop, identical app); point pywebview at the same URL when a real app window is wanted.
  One Python process serves everything; there is no separate Node runtime at run time.
- **Routing:** React Router.
- **Styling:** Tailwind CSS 3 + **CSS custom properties** for all design tokens
  (`src/theme/tokens.css`). Utility-first classes; every Tailwind colour name binds to a
  token variable, so components carry no hex values.
- **Data layer:** `@tanstack/react-query` for async fetching, caching, and job polling.
- **Editor state:** Zustand stores (`src/stores/`) for selection, playhead, zoom, and the
  in-progress edit list; server data stays in the React Query cache.
- **Waveform:** wavesurfer.js v7, wrapped in `src/features/waveform/`.
- **Components:** a **custom UI library** in `src/components/ui/` (no shadcn/Radix/MUI).
  The primitives — `Button`, `SegmentedControl`, `Tabs`, `Badge`, `Modal`/`SimpleModal`,
  `Alert`, `Toast`, `Tooltip`, `Slider`, `Input`, `Progress`, `EmptyState` and
  `WaveformLoader` — are React components styled to the design tokens.
  Ornament (arch, dome, lattice, Rub el Hizb star, cartouche, ribbon tab) is pure geometry
  in `src/ornament/`, drawn by components in `src/components/ornament/`.
- **Lint/format:** Biome.

## Design tokens (`frontend/src/theme/tokens.css`, bound by name in Tailwind)

"Mushaf × Mihrab": paper and ink with an oxblood accent by day, the same layout by night
with gold as the accent. Day values sit on `:root`, night values under
`:root[data-theme="night"]`. [theme.ts](../../frontend/src/theme/theme.ts) resolves the
theme preference (`system`, `day` or `night`; `system` follows `prefers-color-scheme`) and
sets the attribute on `<html>`.

```
                                             day        night
Background     --color-background            #F5EFE3    #1B1416
  surface      --color-surface               #FAF6EC    #2A1E20   pages, panels
  secondary    --color-background-secondary  #EDE5D4    #241A1B   sheets, sunk areas
  tertiary     --color-background-tertiary   #E3D8C2    #3A2C2C   tracks, inactive
Text           --color-text                  #2A2320    #EDE3CC
  secondary    --color-text-secondary        #5A4D45    #BFAF95
  tertiary     --color-text-tertiary         #6F6157    #9C8C76
Accent         --color-accent                #6A1E28    #C9AA66   primary actions, active
  hover        --color-accent-hover          #4F161D    #DCC791
  soft         --color-accent-soft           accent at 7%  /  16%
  on accent    --color-on-accent             #FBF8F1    #2A1E20
Gold           --color-gold                  #B8954F    #C9AA66   rules, ornament
Green          --color-green                 #2E4A3D    #6E9A86   markers, done states
Border         --color-border                #E0D5C1    #3A2C2C   focus = accent
Semantic       error #B5432F / #D9734F   success = green   warning #9A6B1E / #D9B26A
```

The dome, lamp, niche, cartouche and app-mark tokens (`--dome-*`, `--lamp-*`, `--niche-*`,
`--cartouche-*`, `--mark-*`) colour the ornament in both themes.

Typography: **Ibarra Real Nova** (serif) for H1 and main headings; **Jost** for body;
**Amiri** and **IBM Plex Sans Arabic** for Arabic (applied via `:lang(ar)`). All faces
are self-hosted `@font-face` declarations with system fallbacks, because the desktop
shell's content policy blocks CDN fetches.

Shape & motion: radius 10px (buttons/inputs), 14px (`rounded-card`, panels); warm-ink
shadows `--shadow-xs..2xl`; durations `--duration-fast 150ms` / `normal 250ms`; easings
`--ease-out`, `--ease-spring`.

### Waveform palette

```
                           token                 day / night
Waveform (played)          --waveform-played     accent: oxblood / gold
Waveform (unplayed)        --waveform-unplayed   #CDBFA6 / #5B4A3E
Cursor                     --waveform-cursor     accent / vellum with a soft gold glow
Silence region fill        --silence-fill        ink at 8%; selected 18%
Cut region                 --cut-stripe          vermilion 45° hatch, error-colour edge lines
Range selection            --selection-fill      gold at 24% / 20%
Marker line                --marker-line         green
```

[themeColors.ts](../../frontend/src/lib/themeColors.ts) resolves the canvas colours from
the tokens, and the engine re-applies them when the theme changes. Markers show as
marginal notes in Ibarra italic; prayer positions show in the prayer outline.

## UX flow

```
[ Library ] -> [ New recording ] -> [ Extracting... progress ] -> [ Editor ]
                                                                    |- overview + waveform + transport
                                                                    |- Silence / Cut / Markers tabs
                                                                    |- prayer outline
                                                                    |- export
```

## Documents in this set

- [01-layout-and-pages.md](01-layout-and-pages.md) — app shell, routes, editor layout.
- [02-waveform-and-playback.md](02-waveform-and-playback.md) — waveform render + transport.
- [03-silence-editing-ui.md](03-silence-editing-ui.md) — highlight, select, cut, save.
- [04-markers-and-prayer-structure.md](04-markers-and-prayer-structure.md) — takbirs & positions.
- [05-state-and-api-integration.md](05-state-and-api-integration.md) — query, stores, jobs.
