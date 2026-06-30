# youtube_audio_extract — Architecture

Planning docs for an app that extracts Quran recitation audio from YouTube and lets the
user edit it: detect and remove silent gaps, and mark prayer positions via takbir
detection. These documents are a **jumping-off point** — they state vision, boundaries,
and data contracts, and lay out candidate approaches for an implementing agent to
research and build optimally. They are not final implementation decisions.

## System shape

```
              YouTube URL
                  |
        +---------v----------+        Python (FastAPI)
        |   AUDIO ENGINE     |   docs/audio/
        |  extraction        |   - URL -> mp3 + metadata
        |  detection         |   - silence -> segments (DATA, no mutation)
        |  prayer (domain)   |   - phrases/takbir -> markers -> positions
        |  editing           |   - EDL -> rendered audio (the only mutator)
        |  service (API)     |   - async jobs + contracts
        +---------+----------+
                  | structured data (segments, markers) over HTTP
        +---------v----------+        Solid JS + Vite + Tailwind (matches `the base theme`)
        |   FRONTEND         |   docs/frontend/
        |  waveform + play   |   - render audio, transport
        |  silence editing   |   - highlight, select, cut, save
        |  markers/structure |   - takbirs, rak'ah/position outline
        |  state + API       |   - Solid Query jobs, EDL, stores
        +--------------------+
```

## The core architectural principle

**Detection is separated from editing.** Analysis (silence, phrases) is *pure* — audio
in, structured data out, no mutation. Editing is the *only* layer that produces new
audio, driven by an Edit Decision List the user builds from detection output. This split
is what makes the interactive frontend possible: the UI renders data, the user decides,
and rendering happens last.

## Document map

**Audio engine — [docs/audio/](audio/)**
- [00-overview.md](audio/00-overview.md) — vision, prayer-domain context, module boundaries.
- [01-extraction.md](audio/01-extraction.md) — YouTube → MP3 (+ metadata, caching).
- [02-silence-detection.md](audio/02-silence-detection.md) — gaps as data; dB gate vs VAD.
- [03-phrase-detection.md](audio/03-phrase-detection.md) — takbir detection (ASR / embeddings / DTW).
- [04-editing-and-export.md](audio/04-editing-and-export.md) — non-destructive EDL, render, export.
- [05-data-model-and-api.md](audio/05-data-model-and-api.md) — shared contracts + service API.

**Frontend — [docs/frontend/](frontend/)**
- [00-overview.md](frontend/00-overview.md) — vision, stack/tokens inherited from `the base theme`.
- [01-layout-and-pages.md](frontend/01-layout-and-pages.md) — shell, routes, editor layout.
- [02-waveform-and-playback.md](frontend/02-waveform-and-playback.md) — waveform render + transport.
- [03-silence-editing-ui.md](frontend/03-silence-editing-ui.md) — highlight, select, cut, save.
- [04-markers-and-prayer-structure.md](frontend/04-markers-and-prayer-structure.md) — takbirs & positions.
- [05-state-and-api-integration.md](frontend/05-state-and-api-integration.md) — query, jobs, stores.

## Current code vs. target

Implemented today (seeds, not the full architecture):
- `youtube_audio_extract/extract.py` — extraction (→ becomes `extraction/`).
- `youtube_audio_extract/detection/silence.py` — `detect_silence()` returns
  `SilenceSegment[]` (the detection/editing separation, in place).
- `youtube_audio_extract/silence.py` — `remove_silence()` (→ moves to `editing/`).
- `youtube_audio_extract/models.py` — `SilenceSegment` (the first shared contract).
- `youtube_audio_extract/pipeline.py` — convenience chain.

Not yet built: `prayer/`, phrase detection, `editing/` package, `service/` API, and the
entire frontend. The docs above scope each.
