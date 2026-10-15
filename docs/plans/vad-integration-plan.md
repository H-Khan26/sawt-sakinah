# Plan: One speech-probability pass, shared by silence detection and surah recognition

> Status: implemented; kept as a design record (revision 3). Makes Silero VAD the active backend
> for **silence detection** and a precision aid for **takbir / phrase detection**.
> Grounded against the code in `sawt_sakinah/detection/`, `prayer/`, `service/`,
> `extraction/`, `frontend/`.
> The phrase parts (takbir/phrase detection, markers, the prayer outline) were retired by
> the [Surah view](../frontend/04-surah-view.md); see
> [docs/audio/03-surah-recognition.md](../audio/03-surah-recognition.md). The speech map now
> feeds silence detection and surah recognition.

## 0. What the product was doing (context for every decision below)

At the time of this plan, sawt-sakinah took a recording of prayer / recitation (YouTube
URL or uploaded file), produced a 16 kHz mono working copy, then ran **read-only
detectors** that annotated the timeline:

- `SilenceSegment`s (Silero VAD by default, ffmpeg `silencedetect` as the fallback),
- `Marker`s for the four prayer phrases in `_arabic.PHRASE_REGISTRY` (takbir, tasmi,
  tahmid, tasleem) via faster-whisper `large-v3` + fuzzy matching,
- `PrayerPosition`s derived from the takbir/tasmi/tasleem stream by a fixed state machine
  (`prayer/structure.py`, cycle qiyam → ruku → i'tidal → sujood → julus → sujood).

The user then edited (cut / keep / fade / marker EDL) and exported through ffmpeg. Layers were
strict: `extraction/` acquires and writes the working copy, `detection/` never writes,
`editing/` is the only layer that renders audio. The service was FastAPI with two thread
pools (`sawt-job`, `sawt-phrase`), threads chosen so jobs shared `phrases._MODEL_CACHE`.
Config is a strict pydantic schema over `config/defaults.yaml` (every key required,
`extra="forbid"`), and models are frozen pydantic.

Everything in this plan has to respect those boundaries: new analysis goes in
`detection/`, anything persisted per source goes on `AudioSource` and is produced in
`extraction/finalize.py`, and every new knob is a required YAML key.

## 1. Goal

1. Make VAD the **default, active** silence detector (it was coded but dormant behind
   `detector: ffmpeg`).
2. Use the same VAD output to **sharpen takbir/phrase markers**: snap Whisper's coarse
   word onsets (~±0.5 s) to real speech-onset boundaries, and transcribe only speech.
3. Run the Silero network **once per audio source**, at extraction time, and derive
   every later view (coarse silences, fine speech spans, any threshold) from the stored
   result without re-running the model.
4. Drop the torch dependency; the whole VAD path runs on onnxruntime + numpy.
5. Clean up the now-redundant / half-wired paths.

Non-goal: the query-by-example embedding backend for phrases (`detector="embeddings"`)
stays out of scope.

## 2. State before this work (grounded)

**Silence**
- `detection/silence.py` dispatched to the VAD path when `detector="vad"`; otherwise ran
  the ffmpeg `silencedetect` energy gate.
- `detection/vad.py` implemented `detect_silence_vad` (Silero via the `silero_vad`
  package, inverted speech spans to silences, merged gaps, measured loudness).
- **Gaps:** `detector: ffmpeg` was the config default; the model was reloaded on every
  call (no cache); `min_speech_duration` was accepted by the function but not exposed on
  `SilenceParams` nor forwarded by `silence_worker` nor by `detect_silence`'s VAD
  dispatch; the frontend sent only `threshold_db` + `min_silence_duration` so the
  backend default always won.
- **Design flaw:** `vad.py` passed the *silence-report* threshold
  (`min_silence_duration`, default 3.0 s) into Silero as `min_silence_duration_ms`.
  Silero therefore glued any two speech runs separated by less than 3 s into one span.
  Those spans were far too coarse to snap takbir onsets to: a takbir followed 0.8 s
  later by "bismillah" lives in the middle of a span, not at an edge. The same knob
  cannot serve both consumers.

**Phrases (takbir)**
- `detection/phrases.py` transcribed the whole file with faster-whisper (`large-v3`,
  int8 CPU), biased the decoder with an Arabic prompt, fuzzy-matched phrases, deduped
  with greedy NMS, returned `Marker`s.
- Whisper ran with `vad_filter=true`: faster-whisper's **own bundled Silero ONNX pass**,
  separate from `detection/vad.py`.
- Whisper cached its model (`phrases._MODEL_CACHE`); onsets documented as coarse.
- Markers feed `derive_structure`, so onset accuracy directly moves prayer-position
  boundaries.

**Shared plumbing**
- `detection/_pcm.py` already decodes any file to in-memory 16 kHz mono float32, the
  exact Silero input.
- `extraction/finalize.py finalize_source` is the shared tail of extract / import /
  split: probe → `make_working_copy` → `AudioSource` → cache. It already emitted
  progress stages (`probe`, `normalize`, `done`); a `segment` stage slots in after
  `normalize`.
- `service/workers.py _localize` copied `local_path` and `working_copy` into the
  project's `audio/` dir; `ProjectStore` healed a missing `working_copy` on read. Both
  needed to learn one more sidecar file.
- `pyproject.toml` `vad` extra was `numpy, onnxruntime, silero-vad, torch, torchaudio`.
  The `silero_vad` package imports torch at import time even for `onnx=True`, so the
  extra was heavy purely because of the wrapper, not the model.

**The redundancy to kill:** enabling VAD silence meant Silero ran for silence, Silero ran
again inside Whisper, and Whisper transcribed the full file including minutes of
recitation nobody is searching for takbir in.

## 3. Target architecture

```
 extraction/finalize.py          detection/segmentation.py
 ┌────────────────────┐          ┌───────────────────────────────────────┐
 │ probe → normalize  │──WAV──▶  │ speech_probs(audio) -> float32[n]     │  Silero ONNX,
 │ → segment → done   │          │   (one prob per 32 ms frame)          │  onnxruntime only
 └────────────────────┘          └──────────────────┬────────────────────┘
        │ AudioSource.speech_map = <stem>.speech.npz │  (persisted sidecar)
        ▼                                            ▼
                    SpeechMap.spans(threshold, min_speech, bridge_gap, pad)
                    pure numpy hysteresis; instant for any parameter set
                                    │
                  ┌─────────────────┴──────────────────┐
                  ▼                                    ▼
         detect_silence (vad)                 detect_phrases (whisper)
         fine spans → invert →                merge spans into clips, pack the clip
         keep gaps >= 3.0 s →                 audio into one stream (no internal VAD),
         SilenceSegment[]                     map words back through clip offsets;
                                              snap marker onsets/ends to span edges
                                                       │
                                                       ▼
                                     prayer/structure.derive_structure(markers)
```

### 3.1 New module: `detection/segmentation.py` (the only Silero owner)

- `speech_probs(audio: ndarray) -> np.ndarray` runs the Silero ONNX network over
  512-sample (32 ms) frames with its recurrent state and returns one speech probability
  per frame; `SpeechMap.compute(path, ffmpeg_bin)` resolves the session first (so a
  missing `vad` extra fails before any decode) and then decodes via `_pcm`.
  Module-level cached `onnxruntime.InferenceSession`, created under a lock. Weights: the official Silero
  16 kHz v6 export vendored under `sawt_sakinah/detection/assets/silero_vad.onnx`
  (MIT; see decision point 1).
- `spans_from_probs(probs, *, threshold, min_speech_duration, min_silence_duration,
  speech_pad) -> list[tuple[float, float]]` reimplements Silero's `get_speech_timestamps`
  post-processing (enter on `threshold`, leave on `threshold - 0.15`, drop short speech,
  bridge short silences, pad) in numpy. No model involved; runs in milliseconds. No
  maximum span length (a ten-minute recitation is one span); times are exact frame
  multiples rather than rounded to 0.1 s.
- `SpeechMap` value object: `probs`, `frame_seconds`, `n_samples` (true decoded length,
  so `duration` and span clamping do not drift up to one padded frame past the audio),
  `model_version`. `load(path)` / `save(path)` as an `.npz` (written to a temp file and
  moved into place atomically); `compute(audio_or_path)`; `spans(...)` with the
  `segmentation.*` defaults. A one-hour file is ~112k frames: 450 KB float32. Negligible
  next to the working copy.
- Because the stored artifact is threshold-independent, **there is no parameter-mismatch
  problem**: every consumer thresholds the same probabilities with its own knobs.
  Only a Silero model version bump invalidates the sidecar.

### 3.2 `detect_silence_vad` becomes a thin consumer
- Takes the `SpeechMap` (or computes it in memory when none is given), calls
  `SpeechMap.spans` with **fine** parameters (`segmentation.bridge_gap` = 0.2 s,
  `min_speech_duration` from config), inverts to gaps via `_spans.invert_spans`, then
  keeps only gaps `>= min_silence_duration` (the user's 3.0 s knob) and applies
  `merge_gap`. Loudness logic stays. `vad.py` stops importing `silero_vad`.
- `speech_threshold` becomes a live slider: re-thresholding is instant.

### 3.3 Phrase detection consumes the same spans
- `speech_spans: list[tuple[float, float]] | None` on `detect_phrases`.
  - **Transcription scoping:** spans are merged into clips (`clip_merge_gap`), padded
    (`clip_pad`), clamped to the file, and the clip audio is decoded and concatenated
    into one 16 kHz stream that is handed to faster-whisper with `vad_filter=False`.
    Whisper therefore never runs its internal Silero and decodes only speech, in as few
    30 s encoder windows as the packed speech needs. Word timestamps come back in
    packed-stream time and are mapped to source time through the per-clip offset table
    (clip chosen by the word's midpoint, edges clamped to the clip).
  - **Onset snapping:** after fuzzy-matching and dedupe, snap each marker's `time` to
    the nearest *fine* span start and `end` to the nearest span end within
    `snap_window` (0.4 s), refusing snaps that would invert the marker. Because the fine
    map splits at ~0.2 s pauses, transition takbirs (which follow the silence of
    ruku/sujood) land on real onsets. Tasmi → tahmid and takbir → recitation with no
    pause will not snap; that is correct behaviour, not a failure.
- When `speech_spans` is None, behaviour is unchanged (full-file transcription with
  Whisper's `vad_filter`).

### 3.4 Persist the speech map on `AudioSource`
- Optional field `speech_map: Path | None` on `AudioSource` (mirrors `working_copy`;
  older projects load as `None`, and the workers compute + persist it on first detect
  through `ProjectStore.update`).
- Produced in `finalize_source` after `make_working_copy` as a `segment` stage
  (`extraction/segment.py write_speech_map`); skipped when there is no working copy or
  the `vad` extra is missing (a `segment`/`skipped` progress event, field left `None`;
  detectors then fall back to ffmpeg / full-file Whisper).
- `_localize` copies it like `working_copy`; `ProjectStore` heal-on-read and the
  extraction cache treat a missing sidecar as `None` rather than an error.
- `AudioSourceView` (wire schema) exposes `has_speech_map: bool` so the frontend can
  decide which controls to show.

## 4. Work items (phased)

### Phase 0 — Baseline & dependency decision
- Verify what Silero ONNX assets are available and pick one to vendor (decision 1).
- Change the `vad` extra to `numpy, onnxruntime` and drop `silero-vad`, `torch`,
  `torchaudio`.
- Record a baseline: `detector="vad"` (torch) and `detector="ffmpeg"` on real
  recordings. Keep the outputs as fixtures for parity checks.

### Phase 1 — Shared segmentation module
- Add `detection/segmentation.py` (`speech_probs`, `spans_from_probs`, `SpeechMap`,
  session cache) and `detection/_spans.py` (span arithmetic shared by both consumers).
- Refactor `detection/vad.py` to consume it; keep the public `detect_silence_vad`
  signature. Fine internal Silero params, coarse report threshold applied after
  inversion.
- Parity check against the `silero_vad` reference: raw probabilities must match the
  package's `OnnxWrapper` output exactly and spans must match `get_speech_timestamps`
  within its 0.1 s rounding.

### Phase 2 — Make VAD the active silence backend (ship with Phase 5)
- Flip `config/defaults.yaml:silence.detector` `ffmpeg` → `vad`.
- Keep the ffmpeg energy gate selectable (dependency-light fallback when the `vad`
  extra is absent). `silence_worker` falls back to ffmpeg and reports
  `{"detector": "ffmpeg", "fallback": "vad unavailable"}` when the map cannot be
  produced, rather than failing the job.
- Plumb `min_speech_duration`: add to `SilenceParams`, forward in `silence_worker` and in
  `detect_silence`'s VAD dispatch.
- `threshold_db` is ignored in VAD mode; keep the field for the ffmpeg path and have the
  frontend hide it. Do **not** ship this flip without Phase 5, or the visible dB slider
  silently does nothing.

### Phase 3 — Persist the speech map
- Add `speech_map` to `AudioSource`; compute in `finalize_source` (`segment` stage);
  copy in `_localize`; heal in `ProjectStore` and the cache; expose `has_speech_map`.
- Both silence and phrase workers prefer the sidecar; lazy compute + save when absent.

### Phase 4 — VAD-assisted phrase detection
- `speech_spans` param on `detect_phrases`; clip packing (concatenated clip audio plus
  an offset table to map word times back); `vad_filter=False` when spans are provided;
  onset snapping helper bounded by `snap_window`.
- Hand-label ~20 takbir onsets and measure error before/after snapping.

### Phase 5 — Frontend controls
- `SilenceControls.tsx`: detector mode toggle (**Energy gate** / **Speech detection**).
  Speech mode hides the dB slider and shows **Speech threshold** (`speech_threshold`)
  and **Minimum gap**. No `min_speech_duration` control is shipped; the backend default
  applies.
- The 400 ms debounced auto-redetect is gated only on a prior detection having run for
  the project: the first run in either mode is manual (button), later slider changes
  re-detect automatically, and switching mode alone never auto-detects.
- The request DTO (`types/api.ts`) carries `detector`, `speech_threshold`, `threshold_db`
  and `min_silence_duration`; the controls send only the fields the active detector
  reads. `min_speech_duration` exists on the type but is not sent.

### Phase 6 — Cleanup
- Remove the `silero_vad` import path entirely; `vad.py` imports span helpers from
  `detection/_spans.py` instead of "up" from `silence.py`.
- Update `docs/audio/02-silence-detection.md`, `03-phrase-detection.md`.

## 5. Data model & API changes

| Area | Change | File |
|---|---|---|
| `AudioSource` | add optional `speech_map: Path` | `models/sources.py` |
| `AudioSourceView` | add `has_speech_map: bool` | `service/schemas.py` |
| `SilenceParams` | add `min_speech_duration`; `detector`, `speech_threshold` already present | `service/schemas.py` |
| `PhraseParams` | add `snap_window`, `clip_merge_gap`, `clip_pad` | `service/schemas.py` |
| `detect_silence` | forward `min_speech_duration`, `speech_map`, `total_duration` into VAD dispatch | `detection/silence.py` |
| `detect_phrases` | add optional `speech_spans`, clip packing, onset snapping | `detection/phrases.py` |
| Frontend DTOs | `min_speech_duration`; `has_speech_map`; phrase clip/snap knobs | `types/api.ts`, `api/*` |

`SilenceSegment` and `Marker` contracts are **unchanged**; snapping only refines
existing `Marker.time`/`end` values.

## 6. Config changes (`config/defaults.yaml` + `config/__init__.py`)

Every key is required by the strict schema, so each new knob goes in both places.

- New section `segmentation:` -- the knobs that turn the persisted probabilities into
  fine speech spans, shared by every consumer:
  - `speech_threshold: 0.5` (moved out of `silence:`),
  - `min_speech_duration: 0.25` (moved out of `silence:`),
  - `bridge_gap: 0.2` (fine-pass bridging; Silero's `min_silence`. The user-facing
    `silence.min_silence_duration` remains the report threshold applied after inversion),
  - `speech_pad: 0.03`.
- `silence.detector`: `ffmpeg` → `vad`. `threshold_db` documented as ffmpeg-only.
- `phrases.snap_window: 0.4`, `phrases.clip_merge_gap: 1.0`, `phrases.clip_pad: 0.3`;
  `phrases.vad_filter` is only used when no spans are available.
- `extraction.create_speech_map: true`.

## 7. Restructuring & cleanup summary

- **New:** `detection/segmentation.py` (Silero ONNX owner + numpy segmenter),
  `detection/_spans.py`, `extraction/segment.py` (sidecar writer), vendored
  `detection/assets/silero_vad.onnx` + `SILERO_LICENSE`.
- **Slimmed:** `detection/vad.py` becomes an inversion/formatting adapter.
- **Removed:** torch/torchaudio/silero-vad from the `vad` extra; Whisper's internal
  Silero pass when a speech map exists; full-file large-v3 transcription when a speech
  map exists.
- **Fixed:** model reload-per-call; dropped `min_speech_duration`; report threshold
  leaking into Silero's bridging threshold.

## 8. Risks & tradeoffs

- **Silero on melodic recitation:** Silero is trained on conversational speech.
  Sustained madd and melodic contours generally register as speech, but low-volume tail
  vowels may dip under 0.5. The stored-probability design makes this cheap to tune
  (drag the slider); validate on the fixtures and consider a lower default
  (0.35–0.4) if recitation gets fragmented.
- **Onset snapping can over-correct.** Bounded by `snap_window`, refuses snaps that
  would invert a marker, and leaves markers with no nearby edge alone. Validate on
  labelled clips.
- **Whisper cost with clips:** resolved by packing the clip audio into one stream
  rather than passing per-clip `clip_timestamps` (which pays a 30 s encoder window per
  clip). Measured on a 275 s file: packed clips 25.8 s against 24.8 s for Whisper's own
  `vad_filter` path, i.e. parity, while dropping the second Silero pass.
- **Extraction latency:** the `segment` stage adds a Silero pass at import time. It is
  CPU-bound and linear in the audio length, a small fraction of the recording's own
  duration. Acceptable; it removes that cost from every later detect.
- **Resource contention:** the torch OOM concern disappears with onnxruntime-only VAD.

## 9. Validation approach

- Silence: VAD vs ffmpeg on the same files (count, boundaries, false cuts through
  recitation) at the 3.0 s report threshold.
- Segmentation parity: raw probabilities against the `silero_vad` reference wrapper;
  spans against `get_speech_timestamps` with matching parameters.
- Phrases: hand-labelled takbir onsets; onset error before/after snapping; large-v3
  wall time full-file vs speech-clipped.
- (Tests are not added as part of this plan unless requested separately.)

## 10. Decision points

1. **Silero weights source: decided -- vendor Silero's official 16 kHz v6 ONNX export
   (`silero_vad_16k_op15.onnx` from the `silero-vad` 6.2.1 package, 1.3 MB, MIT).**
   faster-whisper's bundled `silero_vad_v6.onnx` (sequence-batched, h/c state) was
   evaluated and rejected: on the taraweeh fixtures it diverges from the reference
   network (correlation 0.77, 66% agreement at 0.5) and labels loud recitation
   (-12 to -15 dB) as non-speech, while the official export reproduces the reference
   exactly and is fast enough per-window (743 s in ~2 s).
2. **Persisted artifact: decided -- frame probabilities** (threshold-independent) rather
   than spans at fixed params.

## 11. Sequencing

Phase 0 → 1 → 3 (sidecar) → 2 + 5 together (VAD live in the UI, no dead dB slider) →
4 (takbir snapping + scoping) → 6 (cleanup, docs). Together these deliver
"speech-aware silence, faster and sharper takbir".
