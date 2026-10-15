# Audio Engine — Architecture Overview

> Status: implemented. Defines the goals, layer boundaries, and data contracts of the
> audio engine as built under `sawt_sakinah/`; the per-topic docs below record the
> concrete library and algorithm choices.

## Vision

The audio engine turns a YouTube link or an uploaded file into a navigable, editable
recitation:

1. **Extract** the audio from a YouTube URL or an uploaded file as an MP3 (no manual
   video download).
2. **Detect** structure in the audio without modifying it:
   - **Silent / relatively-silent regions** — the gaps in a recitation.
   - **The recited surahs** — which surah and which ayat are recited, and where, found
     by transcribing the recitation and matching it against the Quran text.
3. **Edit** the audio based on that structure: cut/remove regions, keep or split off a
   surah, and export a clean result with the surahs as chapters.

The engine is a **headless library + service**. It never owns presentation. It emits
**structured data** (timestamps, labels, confidence) that the frontend renders, and it
performs **transformations** only when explicitly asked.

## Domain context (why this exists)

The target use case is Quran recitation captured during prayer (salah). A recording of a
prayer holds, in order, for each **rak'ah** (unit):

- a **takbir** ("Allahu Akbar") as the imam moves into standing;
- **Al-Fatihah**, then a **surah** or a stretch of one (later rak'ahs often hold
  Al-Fatihah alone);
- quiet or near-silent **ruku'** (bowing) and **sujood** (prostration), each entered and
  left with a takbir;

and the prayer closes with the tasleem and often **adhkar** or a du'a after it. Al-Fatihah
is recited in every rak'ah, so a four-rak'ah prayer holds it four times; the surah after
it may change each rak'ah or run on across them.

Consequences for the engine:

- **"Silence" is domain-specific.** The loud, recited portions are the standing
  recitation (Al-Fatihah + surah). The quiet portions (ruku', sujood, pauses between
  ayat) are what the user wants to find and often trim. These quiet portions are
  frequently **not true silence** — there is quiet dhikr and room noise. Detection must
  distinguish *recitation* from *non-recitation*, not just *sound* from *no-sound*;
  voice-activity detection does this, with a dB gate as the fallback.
- **The surahs are what the user navigates by.** Knowing which surah sits where lets the
  user keep one surah, split it into its own recording, or label the export by surah.
  Everything else in the recording is what the matcher steps over: takbirs, Amin after
  Al-Fatihah, adhkar and du'a are speech that doesn't match the Quran text, so a passage
  ends there; and a long pause (ruku', sujood) separates the rak'ahs of a surah read
  across a prayer into separate passages.

## Module boundaries (the key separation)

```
sawt_sakinah/
  extraction/      # YouTube URL -> mp3 + metadata. Side-effecting (network, files).
  detection/       # Pure analysis. Audio in -> structured data out.
    silence.py     #   detect_silence(audio) -> [SilenceSegment]  (vad or ffmpeg backend)
    segmentation.py#   Silero VAD speech probabilities -> SpeechMap (one pass per source)
    vad.py         #   invert a SpeechMap into [SilenceSegment]
    transcribe.py  #   transcribe(audio, speech_spans) -> [Word]  (Whisper, source time)
    quran.py       #   the Tanzil Quran text, normalized and indexed
    surahs.py      #   match_surahs(words) -> [SurahPassage]  (pure, no audio)
    whisper_models.py # model catalog, pinned download, on-disk layout
  editing/         # Transformations. (audio + edit decisions) -> new audio file.
  models/          # Dataclasses / pydantic types shared across layers (the contracts).
  service/         # API layer (FastAPI) + async job handling. Optional at first.
```

**Rule:** `detection/` must never write audio files or mutate input. It takes audio (a
path or array) or a transcript and returns data; the service persists the data and the
transcript sidecar. `editing/` is the only place that
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
- `SurahPassage` — `{ surah, ayah_from, ayah_to, start, end, confidence, level }`, with
  `level` `accept` or `unsure`; a `SurahMap` holds a run's passages.
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

- [01-extraction.md](01-extraction.md) — YouTube or upload → MP3.
- [02-silence-detection.md](02-silence-detection.md) — finding the gaps (data, not cuts).
- [03-surah-recognition.md](03-surah-recognition.md) — finding the recited surahs and ayat.
- [04-editing-and-export.md](04-editing-and-export.md) — non-destructive cut/remove/save.
- [05-data-model-and-api.md](05-data-model-and-api.md) — contracts + service surface.
