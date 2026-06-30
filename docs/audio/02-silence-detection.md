# Silence Detection

> Status: planning. Detection logic must be **separated from removal** (see overview).
> This doc defines what detection produces and the candidate approaches to evaluate.

## Goal

Analyze an audio file and return a structured list of silent / relatively-silent
regions **as data** — start/end timestamps and loudness — without modifying the audio.
The frontend highlights these regions for selection; the editing layer (separately)
may later cut them.

This is the inverse of the current `remove_silence`: that function *cuts*; detection
*reports*. Removal becomes one possible consumer of detection output.

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
**"sound vs no-sound."** A fixed dB gate is the baseline but will mis-handle quiet
speech and noisy recordings. Plan for a tunable, possibly VAD-based, approach.

## Candidate approaches (for the agent to evaluate)

1. **FFmpeg `silencedetect` filter** *(recommended baseline)*
   - `-af silencedetect=noise=<threshold_db>dB:d=<min_duration>` prints
     `silence_start` / `silence_end` to stderr; parse into segments.
   - Fast, dependency-light (ffmpeg already required), deterministic. Good default and
     the natural sibling of the existing `silenceremove` usage.
   - Weakness: pure energy gate; no notion of speech.

2. **librosa energy / `librosa.effects.split`**
   - `top_db` threshold over RMS frames; returns non-silent intervals (invert for
     silence). Python-native, integrates with numpy, easy to tune and visualize.
   - Good for experimentation and custom thresholds; pulls in a heavier dependency.

3. **pydub `detect_silence` / `detect_nonsilent`**
   - Simple, readable, fewer knobs. Fine for a quick implementation; slower on long files.

4. **Voice Activity Detection (VAD)** *(likely upgrade)*
   - Silero VAD (PyTorch) or WebRTC VAD: classify speech vs non-speech per frame.
   - Better separates quiet dhikr / noise from actual recitation than an energy gate.
   - Evaluate accuracy on real recitation audio vs the added model dependency.

## Tunable parameters (expose these)

- `threshold_db` — loudness below which counts as silence (e.g. -40 dB). Tunable so
  "relatively silent" is adjustable per recording.
- `min_silence_duration` — ignore quiet runs shorter than this (preserve natural
  pauses between words/ayat).
- (VAD path) sensitivity / speech-probability threshold.
- Optional `merge_gap` — merge adjacent silences separated by a tiny blip.

## Practical considerations

- **Normalize input** (16 kHz mono) before analysis so thresholds are stable across
  sources. Loudness normalization (EBU R128 / `loudnorm`) may make `threshold_db`
  meaningful across recordings with different overall levels.
- **Return everything; let the UI/edit layer filter.** Detection should report all
  qualifying segments. Decisions about which to cut belong to the user/editing layer,
  not detection.
- **Performance**: streaming/segmented analysis for long recordings; report progress.

## Boundary

`detection/silence.py` returns `list[SilenceSegment]` and nothing else. It does not
cut, export, or decide. Cutting lives in [04-editing-and-export.md](04-editing-and-export.md).
