# Architecture

sawt-sakinah turns a recording of salah or Quran recitation into an annotated, editable
timeline. The Python engine acquires the audio, analyses it into structured data
(silences, prayer-phrase markers, prayer positions), and renders the user's edits. The
React frontend is a control surface over that engine: it shows the data, the user decides,
and rendering happens last.

## System shape

```
   YouTube URL / uploaded file
              |
   +----------v-----------+   Python (FastAPI, thread-pool jobs)      docs/audio/
   |  extraction          |   download or import -> mp3, 16 kHz working copy,
   |                      |   Silero speech-probability sidecar (once per source)
   |  detection           |   silence spans, phrase markers        (data only)
   |  prayer              |   markers -> rak'ah / position outline
   |  editing             |   EDL -> rendered audio                (the only writer)
   |  service             |   projects, jobs, media, export routes
   +----------+-----------+
              | JSON contracts (models/, mirrored in frontend/src/types/api.ts)
   +----------v-----------+   React 18 + Vite + Tailwind + TanStack Query      docs/frontend/
   |  waveform + transport|   wavesurfer.js, playback, zoom
   |  silence editing     |   detect, select, cut, ripple view
   |  markers + structure |   takbir markers, prayer-position panel
   |  projects + export   |   library, split, export modal
   +----------------------+   served by the API, or wrapped in a pywebview window
```

## The principle every module follows

**Detection returns data; editing produces files.** `detection/` and `prayer/` never
write audio. `extraction/` writes the working copy and its sidecars once. `editing/` is
the only layer that renders new audio, driven by an edit decision list the user built from
detection output. Every tuning knob lives in one strict config file,
`sawt_sakinah/config/defaults.yaml`, and code binds its defaults from it.

## Document map

**Audio engine: [audio/](audio/)**
- [00-overview.md](audio/00-overview.md): vision, prayer-domain context, module boundaries.
- [01-extraction.md](audio/01-extraction.md): YouTube download and file import, working copy, caching.
- [02-silence-detection.md](audio/02-silence-detection.md): speech-probability (Silero VAD) default and the ffmpeg energy gate.
- [03-phrase-detection.md](audio/03-phrase-detection.md): takbir and phrase markers with Whisper, speech-scoped and snapped.
- [04-editing-and-export.md](audio/04-editing-and-export.md): non-destructive EDL, render, export.
- [05-data-model-and-api.md](audio/05-data-model-and-api.md): shared contracts and the service API.

**Frontend: [frontend/](frontend/)**
- [00-overview.md](frontend/00-overview.md): stack, theme tokens, boundaries.
- [01-layout-and-pages.md](frontend/01-layout-and-pages.md): shell, routes, editor layout.
- [02-waveform-and-playback.md](frontend/02-waveform-and-playback.md): waveform rendering and transport.
- [03-silence-editing-ui.md](frontend/03-silence-editing-ui.md): highlight, select, cut, save.
- [04-markers-and-prayer-structure.md](frontend/04-markers-and-prayer-structure.md): markers and positions.
- [05-state-and-api-integration.md](frontend/05-state-and-api-integration.md): queries, jobs, stores.
- [06-implementation-plan.md](frontend/06-implementation-plan.md): the build record and current file map.

**Design records: [plans/](plans/)**
- [vad-integration-plan.md](plans/vad-integration-plan.md): one Silero pass per source shared by silence and phrase detection.
- [backend-project-crud-plan.md](plans/backend-project-crud-plan.md): project library, rename, delete.
- [frontend-project-library-plan.md](plans/frontend-project-library-plan.md): library page and in-editor switcher.
- [resilient-processing.md](plans/resilient-processing.md): checkpoint and resume for long jobs (proposed).

Images used by the root README live in [assets/](assets/).
