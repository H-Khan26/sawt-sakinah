# Audio Extraction (YouTube → MP3)

> Status: implemented (`sawt_sakinah/extraction/`). This doc states the goal of the
> acquisition layer and the shape it hands to the rest of the pipeline.

## Goal

Given a YouTube URL or an uploaded media file, produce a local audio file plus metadata,
reliably and repeatably, as the entry point to the whole pipeline. The user provides
only a link or a file.

## Current state

`extraction/extractor.py::extract_audio(url, ...)` does the YouTube job: it uses the
`yt_dlp` Python API with `format="bestaudio/best"` and the `FFmpegExtractAudio`
postprocessor to go straight from a link to an MP3. Quality and format are parameters.
`extraction/importer.py::import_file(path, ...)` is the upload counterpart: it validates
that ffmpeg can decode the file and that it carries an audio stream, then transcodes it to
the same MP3 artifact. Both converge on `extraction/finalize.py::finalize_source`, which
probes, hashes, normalizes, and caches the result.

## Return shape

Both front-ends return an `AudioSource` record (`models/sources.py`) rather than a bare
path, so downstream layers get metadata for free and never branch on provenance:

```
AudioSource:
  id                str          # deterministic short id (source key + format + quality)
  source_kind       "youtube" | "upload"
  source_url        str?         # canonical URL; None for uploads
  original_filename str?         # uploaded file's name; None for YouTube
  local_path        Path         # the user-facing mp3
  title             str          # from yt-dlp info, or the uploaded file's stem
  duration_sec      float
  sample_rate       int
  channels          int
  codec             str          # e.g. "mp3"
  created_at        datetime
  content_hash      str          # hash of the audio bytes, for caching/dedup
  working_copy      Path?        # 16 kHz mono WAV for detection
  speech_map        Path?        # Silero speech-probability sidecar
```

## Design notes

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
