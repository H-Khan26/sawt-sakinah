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
  # cut: remove [start,end]; keep: retain only listed keeps; fade: at a boundary;
  # marker: accepted so older EDLs still load, ignored by the render

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
- **Surah chapters** — the recognised surahs are analysis data, not edits; export can
  write the accepted passages as chapters (below).

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
- Preserve/refresh metadata (title, source URL).
- **Chapters** (`ExportRequest.embed_chapters`, default `editing.embed_chapters`): each
  accepted surah passage (`Project.surahs`, level `accept`; unsure ones are skipped)
  becomes a chapter, labelled `<transliteration> · <from>–<to>` from the Tanzil
  metadata, e.g. `Al-Hajj · 1–24` (`Al-Hajj · 5` for a single ayah). A chapter starts at
  the first moment of its passage that survives the edits, remapped to the output
  timeline; a passage cut entirely (or outside an exported range) gets no chapter, and
  when two land on the same time the later one is kept. Each chapter runs until the next
  (the last until the end of the file).
  They are written through an ffmetadata file (`editing/render.py`). EDL `marker` ops
  are ignored.
- **Range export and split**: an export may carry `range_start`/`range_end` to render
  only that source range (edits inside it still applied, the saved EDL untouched). Split
  (`POST /projects/{id}/split`) takes one or more `ranges`, joins them back to back with
  the edits inside them applied, and imports the result as a new project with its own
  audio and an empty EDL. Both work by adding `keep` ops to a copy of the EDL.
- Quality knobs: bitrate / VBR quality, sample rate (carried from data model).
- Return an export artifact record (path, format, duration, applied EDL reference).
- The service renders to `exports/<id>.part.<ext>` and renames it to `<id>.<ext>` only
  once ffmpeg and the probe succeed; a failed or interrupted export removes its partial
  file, and the startup sweep removes any a hard exit left behind (see
  [05-data-model-and-api.md](05-data-model-and-api.md)).
- In the desktop app (`ServiceSettings.export_to_folder`) the finished file is then moved
  (copied across drives) to the user's export folder (`preferences.export_dir`, Downloads
  by default) under its name, never overwriting (`name (2).mp3`)
  (`service/export_folder.py`). The folder is checked before rendering, so a missing or
  blocked folder fails at once with a message that says what to do. If saving still fails,
  the render stays in the project and the job reports `save_error`; "Save to folder"
  (`POST /projects/{id}/exports/{a}/save`) retries it. The saved file belongs
  to the user (`ExportArtifact.external`): its entry stays listed if it is moved, and
  deleting the recording leaves it in place. A browser downloads the project's copy
  instead.

## Boundary

This layer consumes contracts (`AudioSource`, `SilenceSegment`, `EDL`, and chapter
`(time, label)` pairs the service builds from the `SurahMap`) and produces audio files. It performs **no detection** — if it needs segments, it calls the
detection layer. Keeping render logic free of analysis keeps both testable in isolation.
