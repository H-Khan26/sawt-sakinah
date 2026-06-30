# Layout & Pages

> Status: planning. Defines the screen/route structure and the editor layout. Follows
> the base theme's layout conventions (sidebar/header shell, cards, spacing scale).

## Goal

A focused, single-flow app: get a link in, work in an editor, export. Keep the surface
small; this is a tool, not a dashboard.

## App shell

Reuse the base theme's shell idea but trim it. Two viable layouts (pick during implementation):

- **Minimal (recommended for v1):** a slim top header (logo in Ibarra Real Nova, app
  title, maybe a "New" action) over a full-bleed editor. No persistent sidebar needed
  for a single-document tool.
- **the base theme-parity:** `DashboardLayout`-style sidebar + header if/when multiple
  saved projects warrant navigation.

Use the base theme's spacing scale (4/8/12/16/24/32/48px), card radius (12–16px), and
shadows. Background `--color-background` (#fcfbf8); panels on `--color-background-secondary`.

## Routes / views

Keep it to a few React Router routes:

```
/                       Landing: link input (and recent projects if persistence exists)
/p/:projectId           Editor: the main workspace
/p/:projectId/export    (optional) export/review step, or a modal instead of a route
```

## Landing view

- Centered card (the base theme `Card` + `Input` + primary `Button`).
- One text input: "Paste a YouTube link". Validate URL shape client-side.
- Submit → `POST /projects` → navigate to `/p/:projectId` and show extraction progress.
- Optional: list of recent/saved projects below (if persistence is implemented).

## Editor view (the core)

A three-region layout. Suggested arrangement:

```
+-------------------------------------------------------------+
| Header: title, source link, export button                   |
+-------------------------------------------------------------+
| Transport bar: play/pause, time, zoom, playback rate        |
+-------------------------------------------------------------+
|                                                             |
|                    WAVEFORM (full width)                    |
|        silence regions highlighted, markers on top          |
|                                                             |
+----------------------------+--------------------------------+
| Silence panel              | Markers / prayer-structure     |
| - detected regions list    | - takbir markers list          |
| - thresholds (sliders)     | - rak'ah / position outline    |
| - select / cut / save      | - jump-to-position             |
+----------------------------+--------------------------------+
```

- The **waveform spans full width** and is the focal point.
- The two panels below it are tabs or side-by-side cards (responsive: stack on narrow
  widths). Use the base theme `Tabs` or `Card` components.
- States to handle explicitly: **extracting** (progress, no waveform yet),
  **analyzing** (waveform shown, detection running with a subtle loading state),
  **ready** (interactive), **exporting** (progress + result).

## Components to build (styled to the base theme tokens)

`Button`, `Card`, `Input`, `Modal`/`SimpleModal`, `Badge`, `Progress`, `Slider`,
`Tooltip`, `LoadingSpinner`, `Tabs`, `Toast`, `EmptyState` — rebuilt in React against
the base theme's design tokens (use the base theme's versions as a visual reference, not a port).
The waveform, transport, silence panel, and markers panel are **new** components (see
the other docs).

## Empty / error states

- No link yet → the base theme `EmptyState`.
- Extraction failure (private/region-locked/removed video) → `Alert` with the typed
  error from the backend and a retry.
- No silences / no markers detected → inline empty messaging in each panel.
