# Waveform & Playback

> Status: planning / library-selection needed. The waveform is the net-new, central
> component. This doc frames requirements and candidate libraries for Solid JS.

## Goal

Render the extracted audio as an interactive waveform with transport controls
(play / pause / seek / zoom), and provide the substrate that silence regions and
markers are drawn onto. Press-and-play must feel immediate.

## Requirements

- Waveform rendering of the full track, themed to the base theme (burgundy played / grey
  unplayed, see [00-overview.md](00-overview.md)).
- Transport: play, pause, seek by click/drag, current-time + duration display,
  optional zoom and playback-rate.
- **Region overlays** for silent segments (highlight, hover, select) — see
  [03-silence-editing-ui.md](03-silence-editing-ui.md).
- **Marker overlays** for takbirs / prayer positions — see
  [04-markers-and-prayer-structure.md](04-markers-and-prayer-structure.md).
- Performance on long recordings (a full prayer can be many minutes): prefer
  precomputed peak data over decoding the entire file in the browser.

## Candidate libraries (framework-agnostic; usable from Solid)

1. **wavesurfer.js v7** *(recommended starting point)*
   - Vanilla-JS, framework-agnostic — wrap in a Solid component (`onMount` to init,
     `onCleanup` to destroy; store the instance in a signal/ref).
   - First-class **Regions** plugin (silence highlights, draggable/selectable) and
     **Markers/Timeline** support — maps directly onto our silence regions and takbir
     markers. Exposes play/pause/seek/zoom and time events.
   - Accepts **precomputed peaks** so we can render instantly from backend peak data.

2. **Peaks.js (BBC)**
   - Built for long-form audio with a zoomable overview + detail view and points/
     segments (markers/regions). Heavier, opinionated; strong for long recordings.

3. **WaveSurfer alternatives / custom canvas**
   - Roll a custom `<canvas>` renderer from backend peaks if libraries don't fit the
     interaction model. Most work; only if needed.

> Evaluate wavesurfer.js v7 first — its Regions + Markers plugins cover both of our
> overlay needs out of the box and it integrates cleanly with Solid's lifecycle.

## Solid integration notes

- Wrap the library instance in a component; keep the instance out of reactive state
  (use a plain ref/variable) and expose imperative controls via a small store.
- Drive UI (play button state, current time) from the library's event callbacks into
  Solid signals.
- Feed regions/markers **declaratively from app state**: when the silence list or
  marker list changes, reconcile the library's regions/markers. Treat app state as the
  source of truth, the waveform as a projection of it.

## Audio source & peaks

- Stream audio from `GET /projects/{id}/audio` (HTTP range requests for seek).
- Prefer `GET /projects/{id}/waveform` returning **precomputed peak data** so the
  component renders without downloading/decoding the whole file. If peaks aren't
  available yet, fall back to client-side decoding for short files.

## Transport details

- Spacebar = play/pause; click/drag on waveform = seek; optional `[`/`]` or buttons for
  zoom; playback-rate selector (useful for scrutinizing fast recitation).
- Show current position relative to markers (e.g. "Rak'ah 2 · sujood") by reading the
  active prayer position from state.
