# Layout & Pages

> Status: implemented. Defines the screen/route structure and the editor layout.

## Goal

A focused, single-flow app: get a recording in, work in an editor, export. Keep the
surface small; this is a tool, not a dashboard.

## App shell

[AppShell.tsx](../../frontend/src/components/layout/AppShell.tsx) picks one of two layouts
by route:

- **Library** ([LibraryShell.tsx](../../frontend/src/components/layout/LibraryShell.tsx)):
  the Sanctuary ([features/landing/](../../frontend/src/features/landing/)). On a cold
  launch it opens under the dome (rosette, logo, name and an Enter button) and descends
  into the library; otherwise it opens descended, with a header on the dome ground holding
  only the logo, the lamp ring as its lower edge, and the theme switch and settings in the
  corner. Below it the qibla wall carries the lamps' light and the star lattice.
- **Editor** ([EditorShell.tsx](../../frontend/src/components/layout/EditorShell.tsx)): an
  88 px binding rail on the dome ground with a gold inner edge (app mark linking home,
  Library, New recording, and the theme switch and settings at its foot), then the main
  area.

Both layouts head the page with the update banner. Use the spacing scale
(4/8/12/16/24/32/48px), the card radius (`rounded-card`, 14px), and the shadow tokens.
Background `--color-background`; pages and panels on `--color-surface`.

## Routes / views

```
/                       Library: "Your recordings"
/new                    Library with the New recording sheet open over it
/p/:projectId           Editor: the main workspace
*                       -> /
```

## Library view

[ProjectLibraryPage.tsx](../../frontend/src/pages/ProjectLibraryPage.tsx):

- Heading row: "Your recordings" and the count, a search field from 12 recordings on, the
  icon/list view toggle (`SegmentedControl`), and a New recording button.
- Recordings, most recently edited first, as an arcade of mihrab niches (`NicheCard`) or
  a fihrist list (`FihristList`). Each shows title, length and date; the ⋯ menu
  (`ProjectMenu`) holds Rename and Delete.
- Dropping a file or pasting a YouTube link anywhere on the page imports straight away
  (`ImportAnywhere`).
- The New recording sheet (`NewRecordingSheet`): a YouTube link field (Enter starts the
  import) and a drop zone for a local file. Both POST to the backend and navigate to
  `/p/:projectId`, which shows extraction progress.

## Editor view (the core)

Every editor state renders on the ruled page
([RuledPage.tsx](../../frontend/src/features/editor/RuledPage.tsx)): a surface sheet edged
by the cetvel double rule. When the main area is at least 760 px tall the page fits it
without scrolling and the lower band scrolls internally; below that the page scrolls.

```
+------+------------------------------------------------------------+
| rail | [ title cartouche / switcher ]   save state   Export        |
|      | overview strip (whole recording, visible range, zoom)      |
|      | marginal notes (markers)                                   |
|      |                 WAVEFORM (full width)                      |
|      |     silences, cuts and markers drawn on it                 |
|      | transport: back 5 s, play, forward 5 s, clock, speed, ...  |
|      | ------------------------ gold rule ----------------------- |
|      | Silence | Cut | Markers (ribbon tabs)  |  prayer outline   |
|      |               tools, 60%               |       40%         |
+------+------------------------------------------------------------+
```

- The **waveform spans full width** and is the focal point.
- The lower band ([LowerBand.tsx](../../frontend/src/features/editor/LowerBand.tsx))
  keeps the tool panels mounted across tab switches; the prayer outline sits beside them.
- States to handle explicitly: **extracting** (progress, no waveform yet),
  **analyzing** (waveform shown, detection running with a subtle loading state),
  **ready** (interactive), **exporting** (progress + result).

## Components (styled to the design tokens)

`Button`, `SegmentedControl`, `Tabs`, `Badge`, `Modal`/`SimpleModal`, `Alert`, `Toast`,
`Tooltip`, `Slider`, `Input`, `Progress`, `EmptyState`, `WaveformLoader` — built in React
against the design tokens. Ornament components (niche,
cartouche, ribbon tab, Rub el Hizb star, cetvel frame, dome, lattice) live in
`src/components/ornament/`. The waveform, transport, silence, cut and markers panels, and
the prayer outline are feature components (see the other docs).

## Empty / error states

- No recordings yet → an empty niche with "No recordings yet" and a New recording button.
- Extraction failure (private/region-locked/removed video) → `Alert` with the typed
  error from the backend and a retry.
- Unknown or still-extracting recording on a deep link → `EmptyState` with "Back to
  library".
- No silences / no markers detected → inline empty messaging in each panel.
