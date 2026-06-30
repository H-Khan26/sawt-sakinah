# Audio Extraction (YouTube → MP3)

> Status: partially implemented (`sawt_sakinah/extract.py`). This doc states
> the goal and the structure to grow it into; an implementing agent should refine.

## Goal

Given a YouTube URL, produce a local audio file plus metadata, reliably and
repeatably, as the entry point to the whole pipeline. The user provides only a link.

## Current state

`extract.py::extract_audio(url, ...)` already does the core job: it uses the `yt_dlp`
Python API with `format="bestaudio/best"` and the `FFmpegExtractAudio` postprocessor
to go straight from a link to an MP3, returning the output path. Quality and format
are parameters.

## Structure to grow into

Move this under `extraction/` and expand the return value from a bare path to an
`AudioSource` record so downstream layers get metadata for free:

```
AudioSource:
  source_url      str
  local_path      Path
  title           str          # from yt-dlp info
  duration_sec    float
  sample_rate     int
  channels        int
  codec           str          # e.g. "mp3"
  extracted_at    datetime
  content_hash    str          # hash of the audio bytes, for caching/dedup
```

## Decisions for the implementing agent to research

- **Lossy re-encode vs native audio.** YouTube serves Opus/AAC; converting to MP3 is
  lossy→lossy. For analysis quality, consider extracting a lossless/WAV working copy
  (16 kHz mono) for detection while keeping the MP3 as the user-facing artifact.
  Detection accuracy may benefit from the uncompressed working copy.
- **Caching.** Key extraction by URL + format/quality params. If the same URL is
  re-submitted, return the cached `AudioSource`. Decide cache location and eviction.
- **Progress reporting.** `yt_dlp` exposes a `progress_hooks` callback — wire it to the
  job/progress mechanism (see [05-data-model-and-api.md](05-data-model-and-api.md)) so
  the frontend can show a download bar.
- **Failure modes.** Private/age-restricted/region-locked videos, live streams,
  removed videos, and yt-dlp version drift. Map yt-dlp's `DownloadError` to typed
  errors the API can return cleanly. yt-dlp needs periodic updates as YouTube changes.
- **Input validation.** Accept a URL or a bare video ID; reject playlists (or decide
  how to handle them) and non-YouTube hosts unless explicitly in scope.
- **Working-copy normalization.** Produce a standardized PCM working file
  (e.g. 16 kHz mono WAV) for the detection layer regardless of source characteristics.

## Boundary

Extraction is **side-effecting** (network + filesystem). It must not perform analysis
or editing. Its only job: get the audio local, describe it, hand off an `AudioSource`.
