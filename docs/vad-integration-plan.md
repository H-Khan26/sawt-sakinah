# Plan: One speech-probability pass, shared by silence, phrases and recitation

> Status: plan, revision 2. Makes Silero VAD the active backend for **silence
> detection**, a precision aid for **takbir / phrase detection**, and the gate in front of
> a new **recitation (Quran ASR) detector** built on the Tarteel models. Grounded against
> the current code (`sawt_sakinah/detection/`, `prayer/`, `service/`, `extraction/`,
> `frontend/`).

## 0. What the product is doing (context for every decision below)

sawt-sakinah takes a recording of prayer / recitation (YouTube URL or uploaded file),
produces a 16 kHz mono working copy, then runs **read-only detectors** that annotate the
timeline:

- `SilenceSegment`s (ffmpeg `silencedetect`, or dormant Silero VAD),
- `Marker`s for the four prayer phrases in `_arabic.PHRASE_REGISTRY` (takbir, tasmi,
  tahmid, tasleem) via faster-whisper `large-v3` + fuzzy matching,
- `PrayerPosition`s derived from the takbir/tasmi/tasleem stream by a fixed state machine
  (`prayer/structure.py`, cycle qiyam → ruku → i'tidal → sujood → julus → sujood).

The user then edits (cut / keep / fade / marker EDL) and exports through ffmpeg. Layers are
strict: `extraction/` acquires and writes the working copy, `detection/` never writes,
`editing/` is the only layer that renders audio. The service is FastAPI with two thread
pools (`sawt-job`, `sawt-phrase`), threads chosen so jobs share `phrases._MODEL_CACHE`.
Config is a strict pydantic schema over `config/defaults.yaml` (every key required,
`extra="forbid"`), and models are frozen pydantic.

Everything in this plan has to respect those boundaries: new analysis goes in
`detection/`, anything persisted per source goes on `AudioSource` and is produced in
`extraction/finalize.py`, and every new knob is a required YAML key.

## 1. Goal

1. Make VAD the **default, active** silence detector (today it is coded but dormant
   behind `detector: ffmpeg`).
2. Use the same VAD output to **sharpen takbir/phrase markers**: snap Whisper's coarse
   word onsets (~±0.5 s) to real speech-onset boundaries, and transcribe only speech.
3. Run the Silero network **once per audio source**, at extraction time, and derive
   every later view (coarse silences, fine speech spans, any threshold) from the stored
   result without re-running the model.
4. Add a **recitation detector** using Tarteel's Quran-tuned Whisper models to split
   speech into *recitation* vs *other speech* and identify surah/ayah ranges. This is the
   piece that makes the phrase pass cheap and gives the prayer state machine a second,
   independent structural cue (Fatiha = start of every rak'ah's qiyam).
5. Drop the torch dependency; the whole VAD path runs on onnxruntime + numpy.
6. Clean up the now-redundant / half-wired paths.

Non-goal: the query-by-example embedding backend for phrases (`detector="embeddings"`)
stays out of scope.

## 2. Current state (grounded)

**Silence**
- `detection/silence.py:68-78` dispatches to the VAD path when `detector="vad"`;
  otherwise runs the ffmpeg `silencedetect` energy gate.
- `detection/vad.py` implements `detect_silence_vad` (Silero via `silero_vad` package,
  inverts speech spans to silences, merges gaps, measures loudness).
- **Gaps:** `detector: ffmpeg` is the config default (`config/defaults.yaml:54`); the
  model is reloaded on every call (`vad.py:82`, no cache); `min_speech_duration` is
  accepted by the function but not exposed on `SilenceParams` (`service/schemas.py`) nor
  forwarded by `silence_worker` (`service/workers.py:176`) nor by `detect_silence`'s VAD
  dispatch; the frontend (`features/silence/SilenceControls.tsx:34-38`) sends only
  `threshold_db` + `min_silence_duration` so the backend default always wins.
- **Design flaw the first revision missed:** `vad.py:89` passes the *silence-report*
  threshold (`min_silence_duration`, default 3.0 s) into Silero as
  `min_silence_duration_ms`. Silero therefore glues any two speech runs separated by
  less than 3 s into one span. Those spans are far too coarse to snap takbir onsets to:
  a takbir followed 0.8 s later by "bismillah" lives in the middle of a span, not at an
  edge. The same knob cannot serve both consumers.

**Phrases (takbir)**
- `detection/phrases.py` transcribes the whole file with faster-whisper (`large-v3`,
  int8 CPU), biases the decoder with an Arabic prompt, fuzzy-matches phrases, dedupes with
  greedy NMS, returns `Marker`s.
- Whisper runs with `vad_filter=true` (`defaults.yaml:68`): faster-whisper's **own
  bundled Silero ONNX pass**, separate from `detection/vad.py`.
- Whisper caches its model (`phrases.py:30 _MODEL_CACHE`); onsets documented as coarse.
- Markers feed `derive_structure` (`workers.py:241`), so onset accuracy directly moves
  prayer-position boundaries. Non-Quranic phrases are also hallucinated *inside*
  recitation by a general Arabic model (Quranic "الله أكبر"-like sequences, e.g. 29:45),
  which the dedupe cannot fix.

**Shared plumbing**
- `detection/_pcm.py` already decodes any file to in-memory 16 kHz mono float32, the
  exact Silero input.
- `extraction/finalize.py:34 finalize_source` is the shared tail of extract / import /
  split: probe → `make_working_copy` → `AudioSource` → cache. It already emits progress
  stages (`probe`, `normalize`, `done`); a `segment` stage slots in after `normalize`.
- `service/workers.py:70 _localize` copies `local_path` and `working_copy` into the
  project's `audio/` dir; `ProjectStore` heals a missing `working_copy` on read
  (`projects.py:125-133`). Both need to learn one more sidecar file.
- `pyproject.toml` `vad` extra is `numpy, onnxruntime, silero-vad, torch, torchaudio`.
  The `silero_vad` package imports torch at import time even for `onnx=True`, so the
  extra is heavy purely because of the wrapper, not the model. faster-whisper (already in
  the `phrases` extra) ships the same Silero ONNX weights and an onnxruntime runner in
  `faster_whisper.vad`.

**The redundancy to kill:** enabling VAD silence today means Silero runs for silence,
Silero runs again inside Whisper, and Whisper transcribes the full file including
minutes of recitation nobody is searching for takbir in.

## 3. Target architecture

```
 extraction/finalize.py          detection/segmentation.py
 ┌────────────────────┐          ┌───────────────────────────────────────┐
 │ probe → normalize  │──WAV──▶  │ speech_probs(audio) -> float32[n]     │  Silero ONNX,
 │ → segment → done   │          │   (one prob per 32 ms frame)          │  onnxruntime only
 └────────────────────┘          └──────────────────┬────────────────────┘
        │ AudioSource.speech_map = <stem>.speech.npy │  (persisted sidecar)
        ▼                                            ▼
                    spans_from_probs(probs, threshold, min_speech, min_silence, pad)
                    pure numpy hysteresis; instant for any parameter set
                                    │
      ┌─────────────────────────────┼───────────────────────────────────┐
      ▼                             ▼                                   ▼
 detect_silence (vad)      detect_recitation (Tarteel)          detect_phrases (whisper)
 fine spans → invert →     per fine span: transcribe with        run large-v3 only on
 keep gaps >= 3.0 s →      whisper-base-ar-quran, match          non-recitation spans
 SilenceSegment[]          against Quran corpus →                (+ edges of recitation
                           RecitationSpan[] (surah:ayah)         spans); snap onsets to
                           and a recitation/other label          fine span edges
                                    │                                   │
                                    └──────────────┬────────────────────┘
                                                   ▼
                                 prayer/structure.derive_structure(markers, recitation)
```

### 3.1 New module: `detection/segmentation.py` (the only Silero owner)

- `speech_probs(input_path | ndarray, *, ffmpeg_bin) -> np.ndarray` runs the Silero
  ONNX network over 512-sample (32 ms) frames with its recurrent state and returns one
  speech probability per frame. Module-level cached `onnxruntime.InferenceSession`.
  Weights: reuse the ONNX file faster-whisper bundles, or vendor the ~2 MB
  `silero_vad.onnx` under `sawt_sakinah/detection/assets/` (Silero is MIT). Decision
  point 1 in section 10.
- `spans_from_probs(probs, *, threshold, min_speech_duration, min_silence_duration,
  speech_pad) -> list[tuple[float, float]]` reimplements Silero's `get_speech_timestamps`
  post-processing (enter on `threshold`, leave on `threshold - 0.15`, drop short speech,
  bridge short silences, pad) in numpy. No model involved; runs in milliseconds.
- `SpeechMap` value object: `probs`, `frame_seconds`, `model_version`, `content_hash`.
  `load(path)` / `save(path)`; `.npy` (float32) or uint8-quantized. A one-hour file is
  ~112k frames: 450 KB float32, 112 KB uint8. Negligible next to the working copy.
- Because the stored artifact is threshold-independent, **there is no parameter-mismatch
  problem**: every consumer thresholds the same probabilities with its own knobs.
  Only a Silero model version bump invalidates the sidecar.

### 3.2 `detect_silence_vad` becomes a thin consumer
- Loads the `SpeechMap` (or computes it lazily for legacy projects), calls
  `spans_from_probs` with **fine** parameters (`min_silence_duration` ≈ 0.1–0.25 s,
  `min_speech_duration` from config), inverts to gaps, then keeps only gaps
  `>= min_silence_duration` (the user's 3.0 s knob) and applies `merge_gap`. Existing
  `_invert_to_silences` + loudness logic stays. `vad.py` shrinks to inversion/formatting;
  it stops importing `silero_vad`.
- `speech_threshold` becomes a live slider: re-thresholding is instant.

### 3.3 Phrase detection consumes the same spans
- Add `speech_spans: list[tuple[float, float]] | None` to `detect_phrases`.
  - **Transcription scoping:** pass the spans as faster-whisper `clip_timestamps` and set
    `vad_filter=False`. faster-whisper then decodes only those regions and never runs its
    internal Silero. Word timestamps stay in source time.
  - **Onset snapping:** after fuzzy-matching, snap each marker's `time` (and `end`) to the
    nearest *fine* speech-span edge within `snap_window` (~0.4 s), and only when the edge
    is closer than the current onset. Because the fine map splits at ~0.2 s pauses,
    transition takbirs (which follow the silence of ruku/sujood) land on real onsets.
    Tasmi → tahmid and takbir → recitation with no pause will not snap; that is correct
    behaviour, not a failure.
- When `speech_spans` is None, behaviour is unchanged.
- **With the recitation detector (section 3.5) in place, the span list handed to
  `detect_phrases` is the *non-recitation* spans plus a ±3 s margin around each
  recitation span.** On a taraweeh recording this cuts large-v3 decode time by an order
  of magnitude and removes hallucinated takbirs inside recitation at the source.

### 3.4 Persist the speech map on `AudioSource`
- New optional field `speech_map: Path | None` on `AudioSource` (mirrors
  `working_copy`; older projects load as `None` and compute lazily on first detect, then
  save through `ProjectStore.update`).
- Produced in `finalize_source` after `make_working_copy` as a `segment` stage; skipped
  when `create_working_copy` is false (no 16 kHz input) or when the `vad` extra is
  missing (log, leave `None`; detectors then fall back to ffmpeg or lazy compute).
- `_localize` copies it like `working_copy`; `ProjectStore` heal-on-read treats a
  missing sidecar as `None` rather than an error.
- `AudioSourceView` (wire schema) exposes `has_speech_map: bool` so the frontend can
  decide which controls to show.

### 3.5 New module: `detection/recitation.py` (Tarteel Quran ASR)

See section 12 for the model facts. Behaviour:

- Input: working copy + fine speech spans.
- For each span (merged up to ~25 s so Whisper's 30 s window is used well), transcribe
  with `tarteel-ai/whisper-base-ar-quran` via faster-whisper (CTranslate2 conversion,
  int8 on CPU; ~75 MB). Word timestamps on.
- Normalize with the existing `_arabic.normalize_arabic` (it already strips harakat; the
  model emits diacritized text) and match the word stream against a normalized Quran
  corpus index (word 4-grams → `(surah, ayah, word_index)`), then run a monotonic
  alignment (Viterbi / longest increasing run over ayah order) so repeated ayat and
  short phrases resolve to the sequence-consistent location.
- Output per span: `RecitationSpan(start, end, surah, ayah_from, ayah_to, confidence)`
  when the corpus match ratio clears `recitation.min_match`; otherwise the span is
  labelled `other` (takbir, dua, dhikr, khutbah, announcements, applause).
- A span is *recitation* iff its transcript matches the corpus. This is the cheapest
  reliable recitation-vs-speech classifier available because the model itself is the
  domain prior; no separate classifier is trained.
- Model cache mirrors `phrases._MODEL_CACHE`; runs in the `sawt-phrase` pool.

### 3.6 Prayer structure gets a second cue
- `derive_structure(markers, *, total_duration, recitation=None)`: when recitation spans
  are present, every recitation span that begins with al-Fatiha (1:1–1:7) is a hard
  qiyam anchor; the takbir marker immediately before it (within a few seconds) is the
  rak'ah-opening takbir. This corrects the two classic failure modes of the pure
  marker walk: a missed takbir (structure drifts one position for the rest of the file)
  and a spurious one (extra rak'ah). Count of Fatiha spans is also a sanity check the UI
  can surface ("4 rak'ahs detected, 3 Fatiha recitations found").
- Output stays `PrayerPosition`; `derived_from` gains the recitation span id.

## 4. Detailed work items (phased)

### Phase 0 — Baseline & dependency decision
- Verify `faster_whisper.vad` exposes the Silero ONNX assets and an onnxruntime runner in
  the pinned version; if the probability API is not public, vendor `silero_vad.onnx` and
  write the 30-line runner (inputs `input[1,512]`, `state[2,1,128]`, `sr`; outputs
  `output`, `stateN`).
- Change the `vad` extra to `numpy, onnxruntime` and drop `silero-vad`, `torch`,
  `torchaudio`.
- Record a baseline: current `detector="vad"` (torch) and `detector="ffmpeg"` on 3–4 real
  recordings (taraweeh with quiet dhikr between rak'ahs, a Fajr with long sujood, a noisy
  phone upload). Keep the outputs as fixtures for parity checks.

### Phase 1 — Shared segmentation module
- Add `detection/segmentation.py` (`speech_probs`, `spans_from_probs`, `SpeechMap`,
  session cache).
- Refactor `detection/vad.py` to consume it; keep the public `detect_silence_vad`
  signature. Fine internal Silero params, coarse report threshold applied after
  inversion.
- Parity check against the Phase 0 baseline; differences should be *more* silences
  found between closely spaced speech, never fewer.

### Phase 2 — Make VAD the active silence backend (ship with Phase 5)
- Flip `config/defaults.yaml:silence.detector` `ffmpeg` → `vad`.
- Keep the ffmpeg energy gate selectable (dependency-light fallback when the `vad`
  extra is absent). `detect_silence` should fall back to ffmpeg with a logged warning
  when `detector="vad"` but onnxruntime is unavailable, rather than 500 the job.
- Plumb `min_speech_duration`: add to `SilenceParams`, forward in `silence_worker` and in
  `detect_silence`'s VAD dispatch.
- `threshold_db` is ignored in VAD mode; keep the field for the ffmpeg path and have the
  frontend hide it. Do **not** ship this flip without Phase 5, or the visible dB slider
  silently does nothing.

### Phase 3 — Persist the speech map
- Add `speech_map` to `AudioSource`; compute in `finalize_source` (`segment` stage);
  copy in `_localize`; heal in `ProjectStore`; expose `has_speech_map` in the view.
- Both silence and phrase workers prefer the sidecar; lazy compute + save when absent.
- Lands before the phrase work because everything downstream reads it.

### Phase 4 — VAD-assisted phrase detection
- `speech_spans` param on `detect_phrases`; `clip_timestamps` scoping;
  `vad_filter=False` when spans are provided; onset snapping helper bounded by
  `snap_window`.
- Guard scoping behind `phrases.transcribe_within_vad` so it can be A/B'd against
  full-file transcription on the Phase 0 fixtures. Hand-label ~20 takbir onsets and
  measure error before/after snapping.

### Phase 5 — Frontend controls
- `SilenceControls.tsx`: detector mode toggle (**Energy gate** / **Speech detection**).
  Speech mode hides the dB slider and shows **Speech sensitivity** (`speech_threshold`)
  and **Minimum gap**; optional advanced `min_speech_duration`.
- The 400 ms debounced auto-redetect is fine in speech mode once the sidecar exists
  (thresholding only); keep it manual when `has_speech_map` is false.
- Extend the request DTO (`types/api.ts`, `api/endpoints.ts`, `api/hooks.ts`) with
  `min_speech_duration`; `detector` and `speech_threshold` already exist on the type but
  are never sent.

### Phase 6 — Recitation detector (Tarteel)
- Vendor or download-on-first-use a normalized Quran text corpus (Tanzil "simple-clean"
  or an equivalent JSON, ~1 MB) under `detection/assets/`, plus a build step that emits
  the n-gram index once and caches it.
- `detection/recitation.py` as in 3.5; `RecitationSpan` model in `models/`;
  `Project.recitation: list[RecitationSpan]`; `recitation_worker` and
  `POST /projects/{id}/detect/recitation` on the phrase pool.
- `phrases_worker` passes non-recitation spans (+ margins) into `detect_phrases` when
  recitation results exist.
- Frontend: a recitation lane on the waveform (surah:ayah chips), "Detect recitation"
  button next to "Detect phrases", and surah names in the prayer structure panel.
- Export: `editing/render.py` already writes FFMETADATA chapters from markers; add
  chapters per surah run.

### Phase 7 — Structure fusion & cleanup
- `derive_structure` takes recitation spans (3.6).
- Remove the `silero_vad` import path entirely; move `_merge_within_gap` and span types
  to `detection/_spans.py` so `vad.py` stops importing "up" from `silence.py`.
- Update `docs/audio/02-silence-detection.md`, `03-phrase-detection.md`, add
  `06-recitation-detection.md`.

## 5. Data model & API changes

| Area | Change | File |
|---|---|---|
| `AudioSource` | add optional `speech_map: Path` | `models/sources.py` |
| `AudioSourceView` | add `has_speech_map: bool` | `service/schemas.py` |
| `SilenceParams` | add `min_speech_duration`; `detector`, `speech_threshold` already present | `service/schemas.py` |
| `detect_silence` | forward `min_speech_duration` into VAD dispatch | `detection/silence.py` |
| `detect_phrases` | add optional `speech_spans`, `clip_timestamps` scoping, onset snapping | `detection/phrases.py` |
| `RecitationSpan` (new) | `start, end, surah, ayah_from, ayah_to, confidence, id` | `models/recitation.py` |
| `Project` | add `recitation: list[RecitationSpan]` | `models/project.py` |
| `derive_structure` | optional `recitation` cue | `prayer/structure.py` |
| Jobs | `JobKind.detect_recitation` | `service/jobs.py`, `routes/detect.py`, `workers.py` |
| Frontend DTOs | `min_speech_duration`; `RecitationSpan`; recitation endpoint/hook | `types/api.ts`, `api/*` |

`SilenceSegment` and `Marker` contracts are **unchanged**; snapping only refines
existing `Marker.time`/`end` values.

## 6. Config changes (`config/defaults.yaml` + `config/__init__.py`)

Every key is required by the strict schema, so each new knob goes in both places.

- `silence.detector`: `ffmpeg` → `vad`.
- `silence.speech_threshold` (0.5), `silence.min_speech_duration` (0.25) stay; now reachable.
- New `silence.vad_internal_min_silence: 0.2` (fine-pass bridging; the user-facing
  `min_silence_duration` remains the report threshold).
- `phrases.snap_to_vad: true`, `phrases.snap_window: 0.4`,
  `phrases.transcribe_within_vad: false` (flip after A/B), `phrases.recitation_margin: 3.0`.
- New section `recitation:` with `model_id: tarteel-ai/whisper-base-ar-quran`
  (or the CT2 conversion id), `device`, `compute_type`, `min_match: 0.7`,
  `max_chunk_seconds: 25`, `corpus_path`.

## 7. Restructuring & cleanup summary

- **New:** `detection/segmentation.py` (Silero ONNX owner + numpy segmenter),
  `detection/recitation.py`, `detection/_spans.py`, `models/recitation.py`, assets
  (Silero ONNX if vendored, Quran corpus + n-gram index).
- **Slimmed:** `detection/vad.py` becomes an inversion/formatting adapter.
- **Removed:** torch/torchaudio/silero-vad from the `vad` extra; Whisper's internal
  Silero pass; full-file large-v3 transcription.
- **Fixed:** model reload-per-call; dropped `min_speech_duration`; report threshold
  leaking into Silero's bridging threshold.

## 8. Risks & tradeoffs

- **Silero on melodic recitation:** Silero is trained on conversational speech.
  Sustained madd and melodic contours generally register as speech, but low-volume tail
  vowels may dip under 0.5. The stored-probability design makes this cheap to tune
  (drag the slider); validate on the Phase 0 fixtures and consider a lower default
  (0.35–0.4) if recitation gets fragmented.
- **Onset snapping can over-correct.** Bounded by `snap_window`, only snaps toward a
  nearer edge, and never applies to markers whose neighbours are inside the same fine
  span. Validate on labelled clips before enabling by default.
- **`clip_timestamps` semantics:** confirm word timestamps returned by faster-whisper are
  in source time for the pinned version; otherwise offset per clip.
- **Tarteel out-of-domain behaviour:** the Tarteel models were fine-tuned only on
  Quranic text, so they will confidently emit Quran-shaped text for takbir, dua and
  speech. That is exactly what `min_match` against the corpus filters out, but the
  threshold needs tuning so short ayat (e.g. 108:1–3, 112) are not rejected while
  "Allahu akbar" is. Use n-gram coverage of the *transcript*, not of the ayah.
- **Repeated ayat:** many ayat recur verbatim (55, 77, 26). The monotonic alignment
  resolves them within a run; an isolated repeated ayah stays ambiguous and should be
  reported with lower confidence rather than guessed.
- **Corpus licensing:** Tanzil text is free with attribution and no modification of the
  text itself; normalization for matching is fine, redistribution of a modified corpus is
  not. Ship the original file and build the normalized index at runtime.
- **Extraction latency:** the `segment` stage adds a Silero pass at import time (roughly
  a few seconds per hour of audio on CPU with onnxruntime). Acceptable; it removes that
  cost from every later detect.
- **Resource contention:** the torch OOM concern in the first revision disappears with
  onnxruntime-only VAD. The Tarteel base model (~75 MB int8) can share the phrase pool
  with large-v3 safely; both run there serially.

## 9. Validation approach

- Silence: VAD vs ffmpeg on the same files (count, boundaries, false cuts through
  recitation) at the 3.0 s report threshold; confirm no silence is reported inside a
  span Tarteel labels as recitation.
- Phrases: hand-labelled takbir onsets; onset error before/after snapping; large-v3
  wall time full-file vs non-recitation-only; count of takbirs falsely detected inside
  recitation before/after scoping.
- Recitation: on recordings with a known surah list, per-span surah accuracy and ayah
  boundary error; recitation/other classification precision on takbir, dua and dhikr
  spans.
- Structure: rak'ah count vs Fatiha count on the fixtures; position boundaries vs
  hand labels with and without the recitation cue.
- (Tests are not added as part of this plan unless requested separately.)

## 10. Decision points (need sign-off before building)

1. **Silero weights source:** reuse faster-whisper's bundled ONNX (couples the `vad`
   extra to faster-whisper) or vendor the 2 MB file (self-contained; recommended).
2. **Persisted artifact:** frame probabilities (recommended; threshold-independent) vs
   spans at fixed params (smaller, but re-run on any parameter change).
3. **Tarteel model variant:** `whisper-base-ar-quran` (recommended: 5.75 WER on
   everyayah, fast on CPU) vs `whisper-tiny-ar-quran` (faster, weaker) vs the
   third-party `large-v3` everyayah fine-tune (heavier, unverified provenance).
4. **CT2 conversion source:** use the community `OdyAsh/faster-whisper-base-ar-quran`
   (float16) or convert `tarteel-ai/whisper-base-ar-quran` ourselves with
   `ct2-transformers-converter` into a pinned local models directory (recommended for
   reproducibility; the source model is Apache 2.0).
5. **Scope of the Fatiha cue in `derive_structure`:** advisory (shown in the UI, not
   applied) first, or authoritative from day one? Recommend advisory until the fixtures
   show it beats the marker walk.

## 11. Suggested sequencing

Phase 0 → 1 → 3 (sidecar) → 2 + 5 together (VAD live in the UI, no dead dB slider) →
4 (takbir snapping + scoping A/B) → 6 (Tarteel recitation) → 7 (structure fusion,
cleanup, docs). Phases 0–5 are a shippable slice ("speech-aware silence, faster and
sharper takbir"); 6–7 deliver recitation identification and rak'ah anchoring.

## 12. Tarteel models: what exists and how they fit

**Published by Tarteel AI (huggingface.co/tarteel-ai):**
- `tarteel-ai/whisper-base-ar-quran` and `tarteel-ai/whisper-tiny-ar-quran`, released
  December 2022, Apache 2.0. Fine-tunes of `openai/whisper-base` / `whisper-tiny` on
  Tarteel's **everyayah** dataset. Reported WER ≈ 5.75 (base) on the everyayah eval set.
- `tarteel-ai/everyayah` (CC BY 4.0): ~127k **ayah-level clips**, 16 kHz, fully
  diacritized transcripts, professional reciters, clip lengths from a few seconds to
  several minutes.
- Community derivatives: `OdyAsh/faster-whisper-base-ar-quran` (CTranslate2 conversion,
  float16, loads directly in faster-whisper), `IJyad/whisper-large-v3-Tarteel` (third-party
  large-v3 fine-tune on everyayah), several LoRA variants.

**What that means for us**
- These are *Quran-only* transcribers. They are the best available model for turning
  recitation into surah:ayah text and a poor choice for the four prayer phrases, none of
  which are Quranic text. Swapping `phrases.model_size` to a Tarteel id (the "drop-in"
  the docstring mentions) is expected to *regress* takbir detection: a base-size model
  has coarser word timing than large-v3 and its decoder is biased toward emitting
  Quranic vocabulary. Keep large-v3 for phrases; add Tarteel as a separate detector.
- Their bias becomes a feature when combined with a corpus check: a span whose Tarteel
  transcript matches the Quran text is recitation; one that does not is "other speech".
  That single test gives the three-way timeline (silence / recitation / other) that the
  rest of this plan leans on.

**Concrete uses, in priority order**
1. **Recitation vs other-speech gate** (3.5) so large-v3 runs only where takbir can be.
2. **Surah:ayah identification** per span, surfaced as a waveform lane, export chapters,
   and searchable navigation ("jump to al-Kahf").
3. **Fatiha anchoring of rak'ah starts** in `derive_structure` (3.6), plus a rak'ah-count
   sanity check in the structure panel.
4. **Ayah-boundary markers** from word timestamps, for a future "cut at ayah boundary"
   snap in the editor.
5. Not now: reciter-style or tajweed feedback. Out of scope for an editing tool.

**Engineering notes**
- Loading: `WhisperModel("<local ct2 dir>", device, compute_type)` through the existing
  `_get_model`-style cache; `language="ar"`, `word_timestamps=True`, no initial prompt
  (the model is already in-domain), `vad_filter=False` (we pass `clip_timestamps`).
- Text normalization: reuse `_arabic.normalize_arabic` for both transcript and corpus.
- Corpus: Tanzil simple-clean (6236 ayat, ~78k words). Index normalized word 4-grams →
  positions; lookups are dictionary hits, no ML.
- CPU cost: base model int8 decodes roughly 10–20× real time on a modern laptop CPU;
  an hour of recitation is a few minutes, comparable to the current large-v3 phrase
  pass and far cheaper than it once phrases are scoped to non-recitation spans.
