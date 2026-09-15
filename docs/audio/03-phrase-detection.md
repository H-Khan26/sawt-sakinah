# Phrase Detection (Takbir & Recurring Utterances)

> Status: planning / research-heavy. This is the most open-ended component. The doc
> frames the problem and lays out candidate approaches; the implementing agent should
> prototype and compare on real recitation audio.

## Goal

Find occurrences of specific spoken phrases in the audio and emit **markers** with
timestamps. The primary phrase is the **takbir — "Allahu Akbar" (الله أكبر)** — because
it announces every transition between prayer positions. Secondary phrases of interest:
**tasmi' ("Sami' Allahu liman hamidah")**, **tahmid ("Rabbana wa laka-l-hamd")**, and
**tasleem ("As-salamu alaykum...")** at the end.

These markers feed the prayer-structure model ([see prayer/ in overview](00-overview.md))
which infers rak'ah and position labels, and they are rendered on the waveform so the
user can navigate by position.

## Output contract

```
Marker:
  time        float    # seconds (onset of the phrase)
  end         float?   # optional offset
  label       str      # human label, e.g. "Allahu Akbar"
  type        str      # "takbir" | "tasmi" | "tahmid" | "tasleem" | "custom"
  confidence  float    # 0..1

detect_phrases(audio, references=..., phrases=...) -> list[Marker]
```

Pure analysis: no audio mutation.

## Why this is hard

- Each takbir is **uttered differently** every time (pitch, duration, melody, reciter,
  mic). This rules out exact audio fingerprinting (Shazam-style), which targets
  identical recordings.
- Recitation is **melodic (tajwid/maqam)**, not flat speech — generic ASR and KWS
  models may degrade.
- The phrase is **Arabic**; tooling and models must support Arabic acoustics.

## Candidate approaches (evaluate and compare)

1. **ASR with word timestamps (Whisper family)** *(strong primary candidate)*
   - Transcribe with Arabic support and word/segment timestamps
     (`whisper`, `faster-whisper`, `whisper-timestamped`), then search the transcript
     for the target phrases (with fuzzy/diacritic-insensitive matching).
   - Pros: semantic, multi-phrase out of the box, gives real labels and times.
   - Cons: may struggle with melodic recitation and exact onset timing; heavier compute.
   - Mitigations: domain prompt/initial-prompt biasing toward the known phrases; when
     the source's Silero speech map exists, its spans are grouped into padded clips,
     the clip audio is concatenated into one stream and transcribed with Whisper's own
     VAD disabled (no second VAD pass; one packed stream costs far fewer 30 s encoder
     windows than per-clip decoding), and word times are mapped back to source time
     through the clip offsets. Marker onsets/ends are then snapped to the nearest
     speech-span edge within `phrases.snap_window`, so a takbir that follows a pause
     lands on the real speech onset rather than Whisper's coarse (~+-0.5 s) word time.

2. **Query-by-example via audio embeddings** *(strong complement / fallback)*
   - User (or a library) supplies one or more **reference clips** of the takbir.
   - Embed sliding windows of the audio and the reference with a model
     (e.g. wav2vec2 / HuBERT, YAMNet, OpenL3, CLAP), score cosine similarity, peak-pick.
   - Pros: no transcription needed; adapts to a specific reciter via the reference;
     robust to melody. Cons: needs reference clips; tuning window size + threshold.

3. **Template matching (MFCC + DTW)**
   - Classic: take a reference takbir, compute MFCCs, slide with Dynamic Time Warping
     to find low-distance matches. Lightweight, no large model.
   - Pros: simple, explainable, cheap. Cons: less robust to large acoustic variation.

4. **Keyword spotting (KWS) model**
   - Train/fine-tune a small KWS model on takbir examples. Best accuracy if data exists,
     but requires a labeled dataset and training effort — likely a later optimization.

### Suggested research path

Start with **(1) Whisper-Arabic for labels + (2) embedding query-by-example for robust
takbir onsets**, then reconcile. (1) gives semantics and secondary phrases; (2) gives
reliable, reciter-specific takbir timing. Compare against hand-labeled clips.

## Reference-clip support

The architecture should allow the user to **mark a known takbir on the waveform and use
it as the reference** for query-by-example (closing the loop between frontend and
engine). Plan a small library of reference embeddings keyed by phrase type.

## Parameters / knobs

- `phrases` — list of target phrase types to look for.
- `references` — optional reference clips/embeddings per phrase.
- `min_confidence`, `min_gap_between_markers` (de-duplicate near-duplicate hits).
- window size / hop (embedding & template paths).

## Boundary

`detection/phrases.py` returns `list[Marker]`. Turning markers into prayer positions
(qiyam → ruku' → ...) is the **`prayer/` module's** job, not this one — a state machine
that consumes the ordered marker stream and applies the known prayer sequence. Keep the
acoustic detection and the domain interpretation separate so each can be improved alone.
