# Audio Editing & Export

> Status: planning (the current `remove_silence` is the seed of this layer).
> This is the **only** layer that produces new audio.

## Goal

Apply edits — primarily removing selected (silent) regions — and export a clean audio
file. Editing is driven by user selections on the frontend and/or by detection output,
expressed as a non-destructive **Edit Decision List (EDL)** that is rendered on export.

## Non-destructive model (important)

Do **not** mutate audio as the user clicks. Instead maintain an EDL against the
original `AudioSource`; render only on export. This enables undo/redo, re-editing, and
keeps the original intact.

```
EditOperation:
  type      "cut" | "keep" | "fade" | "marker"
  start     float
  end       float
  # cut: remove [start,end]; keep: retain only listed keeps; fade: at a boundary

EditDecisionList:
  source_id   str
  operations  list[EditOperation]
  created/updated timestamps

render(audio_source, edl, out_format, ...) -> Path
```

A "remove all detected silence" action is just: take `detect_silence(...)` output →
turn each segment into a `cut` op → render. This is exactly the separation the overview
asks for: detection produces data, the user/edit layer decides, rendering executes.

## Operations to support

- **Cut / remove region** — delete `[start, end]`, concatenate the remainder.
- **Keep-only selection** — inverse: keep listed regions, drop the rest.
- **Trim silence (bulk)** — apply detected silence segments as cuts in one action,
  with the tunable thresholds from silence detection.
- **Boundary fades / crossfades** — apply short fades at every cut to avoid clicks/pops
  (concatenating non-zero-crossing samples produces audible artifacts). This is a
  quality must-have, not optional.
- **Marker export** — markers are metadata, not edits, but export may embed them
  (chapters/cue points) or emit a sidecar file.

## Rendering approaches (evaluate)

- **FFmpeg filtergraph** — `atrim` + `concat`, or `aselect`/`silenceremove` for the
  bulk-silence case; `afade`/`acrossfade` for boundaries. Fast, no full decode into
  memory, scales to long files. Natural continuation of current code.
- **pydub** — slice `AudioSegment` objects and concatenate with crossfades. Very
  readable; loads audio into memory (watch long files). Good for prototyping.
- **numpy/librosa + soundfile** — full control for sample-accurate edits and fades;
  most code, best precision.

The existing `remove_silence` (ffmpeg `silenceremove`) should be relocated here and
generalized to accept either a threshold (compute segments internally) or an explicit
segment/EDL input.

## Export

- Formats: MP3 (user artifact) and optionally WAV (lossless working/export).
- Preserve/refresh metadata (title, source URL). Optionally embed markers as chapters.
- Quality knobs: bitrate / VBR quality, sample rate (carried from data model).
- Return an export artifact record (path, format, duration, applied EDL reference).

## Boundary

This layer consumes contracts (`AudioSource`, `SilenceSegment`, `Marker`, `EDL`) and
produces audio files. It performs **no detection** — if it needs segments, it calls the
detection layer. Keeping render logic free of analysis keeps both testable in isolation.
