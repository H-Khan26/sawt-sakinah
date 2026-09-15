# Audio Engine — Architecture Overview

> Status: implemented. Defines the goals, layer boundaries, and data contracts of the
> audio engine as built under `sawt_sakinah/`; the per-topic docs below record the
> concrete library and algorithm choices.

## Vision

The audio engine turns a YouTube link into a navigable, editable recitation:

1. **Extract** the audio from a YouTube URL as an MP3 (no manual video download).
2. **Detect** structure in the audio without modifying it:
   - **Silent / relatively-silent regions** — the gaps in a recitation.
   - **Recurring spoken phrases** — primarily the takbir ("Allahu Akbar"), which
     marks transitions between prayer positions.
3. **Edit** the audio based on that structure: cut/remove regions, place markers,
   and export a clean result.

The engine is a **headless library + service**. It never owns presentation. It emits
**structured data** (timestamps, labels, confidence) that the frontend renders, and it
performs **transformations** only when explicitly asked.

## Domain context (why this exists)

The target use case is Quran recitation captured during prayer (salah). A prayer is
made of **rak'ah** (units). Within each rak'ah the reciter moves through positions,
and each transition is announced by a **takbir** ("Allahu Akbar"):

```
qiyam (standing): Al-Fatihah + a surah  --takbir-->
ruku' (bowing): quiet tasbih            --tasmi' / takbir-->
i'tidal (standing up)                   --takbir-->
sujood (prostration): quiet tasbih      --takbir-->
julus (sitting)                         --takbir-->
sujood (second prostration)             --takbir-->
[stand for next rak'ah]                 ... tasleem at the end
```

Consequences for the engine:

- **"Silence" is domain-specific.** The loud, recited portions are qiyam (Fatihah +
  surah). The quiet portions (ruku', sujood, pauses between ayat) are what the user
  wants to find and often trim. These quiet portions are frequently **not true
  silence** — there is quiet dhikr and room noise. Detection must distinguish
  *recitation* from *non-recitation*, not just *sound* from *no-sound*. A simple dB
  gate is the baseline; voice-activity detection is the likely upgrade.
- **Takbirs are structural anchors.** Detecting them lets us auto-place markers for
  rak'ah/position boundaries. Phrase detection therefore feeds a small **prayer-state
  model** that turns a sequence of detected phrases into labeled positions.

## Module boundaries (the key separation)

```
sawt_sakinah/
  extraction/      # YouTube URL -> mp3 + metadata. Side-effecting (network, files).
  detection/       # Pure analysis. Audio in -> structured segments/markers out.
    silence.py     #   detect_silence(audio) -> [SilenceSegment]  (vad or ffmpeg backend)
    segmentation.py#   Silero VAD speech probabilities -> SpeechMap (one pass per source)
    vad.py         #   invert a SpeechMap into [SilenceSegment]
    phrases.py     #   detect_phrases(audio, refs) -> [Marker]
  prayer/          # Domain logic. [Marker] -> labeled positions / rak'ah structure.
  editing/         # Transformations. (audio + edit decisions) -> new audio file.
  models/          # Dataclasses / pydantic types shared across layers (the contracts).
  service/         # API layer (FastAPI) + async job handling. Optional at first.
```

**Rule:** `detection/` and `prayer/` must never write audio files or mutate input.
They take audio (a path or array) and return data. `editing/` is the only place that
produces new audio. This is what makes the frontend possible: the UI consumes
detection output, the user selects, and only then does an edit get rendered.

### Detection and removal in code

Detection and removal are separate modules with one contract between them:

- `detection/silence.py::detect_silence(...) -> list[SilenceSegment]` reports timestamps
  instead of cutting, via the Silero speech map (`"vad"` backend) or the ffmpeg
  `silencedetect` energy gate (`"ffmpeg"` fallback).
- `editing/silence.py::remove_silence(...)` accepts either a threshold (segments computed
  internally) or an explicit list of segments to cut, and renders through
  `editing/render.py`.
- `extraction/` acquires audio from a YouTube URL (`extractor.py`) or an uploaded file
  (`importer.py`) and hands downstream layers an `AudioSource`.

## Data contracts (the spine of the system)

These types are the interface between every layer and the frontend. See
[05-data-model-and-api.md](05-data-model-and-api.md) for full schemas; the essentials:

- `AudioSource` — url, local path, duration, sample rate, channels, codec.
- `SilenceSegment` — `{ start, end, duration, mean_db }` (seconds, float).
- `Marker` — `{ time, label, type, confidence }` (e.g. type `takbir`).
- `PrayerStructure` — ordered positions/rak'ahs derived from markers.
- `EditDecisionList` (EDL) — ordered keep/cut operations; the non-destructive record
  of edits that `editing/` renders on export.

## Cross-cutting concerns to plan for

- **Long-running work**: extraction and ML detection take seconds-to-minutes. The API
  must be async (job + progress), not a blocking request. See data-model doc.
- **Determinism & caching**: same URL + same params should reuse prior extraction and
  detection results. Key by URL + content hash + param set.
- **Sample-rate / channel normalization**: detection should standardize input (e.g.
  16 kHz mono) so thresholds and models behave consistently, independent of source.
- **FFmpeg is a hard runtime dependency** (standalone binary, not a pip package).

## Documents in this set

- [01-extraction.md](01-extraction.md) — YouTube → MP3.
- [02-silence-detection.md](02-silence-detection.md) — finding the gaps (data, not cuts).
- [03-phrase-detection.md](03-phrase-detection.md) — finding takbirs / recurring phrases.
- [04-editing-and-export.md](04-editing-and-export.md) — non-destructive cut/remove/save.
- [05-data-model-and-api.md](05-data-model-and-api.md) — contracts + service surface.
