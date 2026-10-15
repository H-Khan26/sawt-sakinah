# Waveform & Playback

> Status: implemented with wavesurfer.js v7 (`src/features/waveform/`). The waveform is
> the central component. This doc records the requirements and the React integration.

## Goal

Render the extracted audio as an interactive waveform with transport controls
(play / pause / seek / zoom), and provide the substrate that silence regions and the
surah view are drawn onto. Press-and-play must feel immediate.

## Requirements

- Waveform rendering of the full track, themed to the app tokens (played bars in the
  accent, oxblood by day and gold at night; unplayed bars in a muted tone; see
  [00-overview.md](00-overview.md)). An overview strip above it shows the whole recording
  with the visible range boxed in gold (`WaveformOverview`), and a diamond on the top rule
  marks the playhead (`PlayheadDiamond`).
- Transport: play, pause, seek by click/drag, current-time + duration display,
  optional zoom and playback-rate.
- **Region overlays** for silent segments (highlight, hover, select) — see
  [03-silence-editing-ui.md](03-silence-editing-ui.md).
- **Surah overlays**: a band of named tabs in the margin above the bars and tints behind
  them and on the overview strip — see [04-surah-view.md](04-surah-view.md).
- Performance on long recordings (a full prayer can be many minutes): prefer
  precomputed peak data over decoding the entire file in the browser.

## Library choice

1. **wavesurfer.js v7** *(adopted)*
   - Vanilla-JS, framework-agnostic — wrapped in a hand-rolled React hook
     (`useWaveformEngine.ts`: init in a `useEffect`, destroy in its cleanup; the instance
     lives in a `useRef`, never in state).
   - First-class **Regions** plugin (silence highlights, selectable) and
     **Timeline/Hover** plugins — these map directly onto the silence and cut regions.
     Exposes play/pause/seek/zoom and time events.
   - Accepts **precomputed peaks**, so the track renders instantly from backend peak data.

2. **Peaks.js (BBC)** *(considered, not adopted)*
   - Built for long-form audio with a zoomable overview + detail view and points/
     segments. Heavier and more opinionated than needed here.

3. **Custom canvas** *(considered, not adopted)*
   - A hand-rolled `<canvas>` renderer over backend peaks was the fallback if no library
     fit the interaction model; wavesurfer's plugins covered the overlay needs.

> wavesurfer.js v7 was chosen because its Regions and Timeline plugins cover both overlay
> needs out of the box and it integrates cleanly with React's lifecycle.

## React integration notes

- Wrap the library instance in a component; keep the instance in a `useRef` (never in
  React state) and expose imperative controls via a small store/context.
- Drive UI (play button state, current time) from the library's event callbacks into
  React state. **Isolate the high-frequency current-time/playhead value** in its own
  state or store slice so per-frame updates don't re-render the whole editor tree —
  subscribe only the transport readout and the active-position indicator to it.
- Reconcile regions in a `useEffect` keyed on the silence and cut lists: when a list
  changes, diff against the library's current regions and add/remove/update. Treat app
  state as the source of truth, the waveform as a projection of it.
- Overlays that are not regions (the surah band and tints, the seams, the playhead diamond)
  are DOM layers in `WaveformView`'s `overlay` slot (over the margin and the bars) or its
  `underlay` slot (behind the bars), and `WaveformOverview`'s `overlay` prop. They place
  themselves with `useOverlayLayout`, which reads the rendered pixels per second and the
  scroll offset and maps an edited time to x.

## Audio source & peaks

- Stream audio from `GET /projects/{id}/audio` (HTTP range requests for seek). Where the
  webview plays MP3 in MP4 (Chromium), request `?container=mp4`: the same MP3 frames in an
  MP4 container, which seeks exactly. A bare VBR MP3 seeks by estimate, so after a seek
  the audio heard can drift seconds from `currentTime` and cuts land in the wrong place.
- Prefer `GET /projects/{id}/waveform` returning **precomputed peak data** so the
  component renders without downloading/decoding the whole file. If peaks aren't
  available yet, fall back to client-side decoding for short files.
- The peaks are RMS levels per 10 ms bucket, scaled once per recording so its loudest
  passages reach full height. The edited view resamples them without changing that scale,
  and a small dB scale at the right edge labels full height, half and quarter height.

## Transport details

- Spacebar = play/pause; ArrowLeft / ArrowRight = skip 5 s; click/drag on waveform =
  seek; zoom with the overview's buttons or Ctrl/⌘ + wheel; playback-rate selector
  (useful for scrutinizing fast recitation).
- `[` / `]` step to the previous / next surah passage start and select its surah; Escape
  clears the selection (see [04-surah-view.md](04-surah-view.md)).
