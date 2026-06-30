# Silence Editing UI

> Status: planning. The primary editing workflow: see the gaps, choose which to remove,
> save. Consumes silence detection data; posts edits to the backend.

## Goal

Make the recitation's silent gaps obvious and let the user remove them with confidence:
highlight detected silences on the waveform, list them, allow per-region and bulk
selection, and apply cut/remove with a non-destructive, undoable model — then export.

## Data in / out

- **In:** `SilenceSegment[]` from `POST /projects/{id}/detect/silence`
  (`{ start, end, duration, mean_db }`, seconds). See
  [../audio/02-silence-detection.md](../audio/02-silence-detection.md).
- **Out:** edits expressed as an Edit Decision List posted via `PUT /projects/{id}/edl`;
  rendered on `POST /projects/{id}/export`. See
  [../audio/04-editing-and-export.md](../audio/04-editing-and-export.md).

The UI never trims audio itself — it manipulates the EDL and asks the backend to render.

## Waveform highlighting

- Draw each `SilenceSegment` as a region overlay (wavesurfer Regions). Fill with a
  low-alpha warning/red or burgundy overlay; selected regions get higher alpha + a solid
  left accent bar (mirror the base theme's table-row selection treatment).
- Hover a region → tooltip with start/end/duration (the base theme `Tooltip`).
- Click a region → toggle selection; selection state lives in app state and reflects in
  both the waveform and the list.

## Silence panel

A `Card` beside/below the waveform:

- **Detection controls** (tunable defaults — the engine exposes these):
  - `threshold_db` slider (e.g. -60..-20 dB) — "how quiet counts as silent".
  - `min_silence_duration` slider (e.g. 0.2..5 s) — "ignore pauses shorter than".
  - Re-run detection on change (debounced) → updates regions live. Show the count
    ("12 silent regions, 38s total").
- **Region list**: each row shows index, start–end, duration; click to seek + select;
  checkbox to include in a cut. Use the base theme list/table styling.
- **Actions**:
  - "Select all" / "Select none".
  - "Remove selected" → adds `cut` ops to the EDL.
  - "Remove all detected silence" → bulk cut of every region (the common one-click path).
  - **Undo / redo** over EDL operations.
- **Preview**: let the user audition the result before export (play with cuts applied),
  or at minimum preview a single cut boundary. Decide feasibility with the chosen
  waveform lib; otherwise rely on export + re-listen.

## Edit model (frontend mirror of the EDL)

- Keep edits as a list of operations against the original timeline; never mutate the
  loaded audio. Re-derive the "kept" timeline for display/preview from original − cuts.
- Map UI actions → EDL ops:
  - Remove region `[s,e]` → `{ type: "cut", start: s, end: e }`.
  - Undo → pop last op; redo → reapply. Persist EDL to backend on change (debounced).
- Apply short **boundary fades** server-side at render (the engine handles click/pop
  avoidance); the UI just marks cuts.

## Save / export

- "Export" → `POST /projects/{id}/export` (format + quality) → job + progress →
  download link / saved artifact. Show in a `Modal` or the export view.
- Communicate clearly that export is the destructive/rendered step; edits before that
  are reversible.

## Theming

Reuse the base theme tokens: selected = burgundy accent; destructive actions = `danger`
button variant (red); sliders/inputs = ported `Slider`/`Input`; counts/labels =
`Badge`. Keep destructive actions guarded (confirm on "remove all" / irreversible export).
