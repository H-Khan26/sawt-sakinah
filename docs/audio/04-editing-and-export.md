# Audio Editing & Export

> Status: implemented (`sawt_sakinah/editing/`: `render.py` renders an EDL,
> `silence.py` is the bulk silence-removal shortcut on top of it).
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

## Rendering approach

- **FFmpeg filtergraph** *(adopted, `editing/render.py`)* — `atrim` + `concat` over the
  kept spans, with `afade` at every boundary. Fast, no full decode into memory, scales
  to long files.
- **pydub** *(not adopted)* — slice `AudioSegment` objects and concatenate with
  crossfades. Very readable; loads audio into memory (a problem for long files).
- **numpy/librosa + soundfile** *(not adopted)* — full control for sample-accurate edits
  and fades; most code, best precision.

`editing/silence.py::remove_silence` lives alongside the renderer and accepts either a
threshold (segments computed internally by the detection layer) or an explicit list of
segments, which it turns into `cut` operations and hands to the same render path.

## Export

- Formats: MP3 (user artifact) and optionally WAV (lossless working/export).
- Preserve/refresh metadata (title, source URL). Optionally embed markers as chapters.
- Quality knobs: bitrate / VBR quality, sample rate (carried from data model).
- Return an export artifact record (path, format, duration, applied EDL reference).
- The service renders to `exports/<id>.part.<ext>` and renames it to `<id>.<ext>` only
  once ffmpeg and the probe succeed; a failed or interrupted export removes its partial
  file, and the startup sweep removes any a hard exit left behind (see
  [05-data-model-and-api.md](05-data-model-and-api.md)).

## Boundary

This layer consumes contracts (`AudioSource`, `SilenceSegment`, `Marker`, `EDL`) and
produces audio files. It performs **no detection** — if it needs segments, it calls the
detection layer. Keeping render logic free of analysis keeps both testable in isolation.
