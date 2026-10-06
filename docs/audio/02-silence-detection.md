# Silence Detection

> Status: implemented. Detection logic is **separated from removal** (see overview).
> This doc defines what detection produces and the detectors behind it.

## Goal

Analyze an audio file and return a structured list of silent / relatively-silent
regions **as data** — start/end timestamps and loudness — without modifying the audio.
The frontend highlights these regions for selection; the editing layer (separately)
may later cut them.

Detection *reports*; it never cuts. Removal (the editing layer) is one consumer of
detection output.

## Output contract

```
SilenceSegment:
  start       float   # seconds
  end         float   # seconds
  duration    float   # end - start
  mean_db     float   # average loudness in the region (for confidence / display)

detect_silence(audio, *, threshold_db, min_silence_duration, ...) -> list[SilenceSegment]
```

Pure function: audio in (path or array), segments out. No file writes.

## Domain nuance — this is the hard part

"Silence" in recitation is rarely true digital silence:

- The quiet portions (ruku', sujood, inter-ayah pauses) often contain **quiet dhikr**
  and **room/mic noise**, not absolute silence.
- The loud portions (qiyam recitation) are what should be *kept*.

So the real task is closer to **"recitation vs not-recitation"** than
**"sound vs no-sound."** A fixed dB gate mis-handles quiet speech and noisy
recordings, which is why the default detector is VAD-based (Silero speech probabilities
with a tunable threshold) and the dB gate is kept only as the dependency-free fallback.

## Detectors

1. **FFmpeg `silencedetect` filter** *(dependency-free fallback, `detector: ffmpeg`)*
   - `-af silencedetect=noise=<threshold_db>dB:d=<min_duration>` prints
     `silence_start` / `silence_end` to stderr; parse into segments.
   - Fast, dependency-light (ffmpeg already required), deterministic. The natural
     sibling of the existing `silenceremove` usage, and what the service falls back to
     when the `vad` extra (onnxruntime) is not installed.
   - Weakness: pure energy gate; no notion of speech.

2. **librosa energy / `librosa.effects.split`** *(considered, not adopted)*
   - `top_db` threshold over RMS frames; returns non-silent intervals (invert for
     silence). Python-native, integrates with numpy, easy to tune and visualize.
   - Still an energy gate, and pulls in a heavier dependency for no gain over ffmpeg.

3. **pydub `detect_silence` / `detect_nonsilent`** *(considered, not adopted)*
   - Simple, readable, fewer knobs; slower on long files and again only an energy gate.

4. **Voice Activity Detection (VAD)** *(the default, `detector: vad`)*
   - Silero VAD, run once per source by `detection/segmentation.py` from a vendored
     ONNX file on onnxruntime + numpy (no torch); the per-frame speech probabilities
     are persisted as the source's speech-map sidecar and `detection/vad.py` inverts the
     thresholded speech spans into silences, so re-thresholding never re-runs the model.
   - Better separates quiet dhikr / noise from actual recitation than an energy gate.

## Tunable parameters

- `threshold_db` — loudness below which counts as silence (e.g. -40 dB). Tunable so
  "relatively silent" is adjustable per recording.
- `min_silence_duration` — ignore quiet runs shorter than this (preserve natural
  pauses between words/ayat).
- (VAD path) `segmentation.speech_threshold` (speech-probability threshold) and
  `segmentation.min_speech_duration`; `threshold_db` is ignored in this mode.
- Optional `merge_gap` — merge adjacent silences separated by a tiny blip.

## Practical considerations

- **Normalize input** (16 kHz mono) before analysis so thresholds are stable across
  sources; the extraction layer writes this working copy. Loudness normalization
  (EBU R128 / `loudnorm`) is available but off by default because it shifts the
  absolute dB values `threshold_db` is tuned against.
- **Return everything; let the UI/edit layer filter.** Detection reports all
  qualifying segments. Decisions about which to cut belong to the user/editing layer,
  not detection.
- **Performance**: the Silero pass runs once per source at extraction time and is
  persisted; every later re-threshold is instant, so the UI can re-detect live as a
  slider moves.

## Boundary

`detection/silence.py` returns `list[SilenceSegment]` and nothing else. It does not
cut, export, or decide. Cutting lives in [04-editing-and-export.md](04-editing-and-export.md).
