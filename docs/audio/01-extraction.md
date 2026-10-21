# Audio Extraction (link or upload → MP3)

> Status: implemented (`sawt_sakinah/extraction/`). This doc states the goal of the
> acquisition layer and the shape it hands to the rest of the pipeline.

## Goal

Given a link to one post (YouTube, Instagram, X or Facebook) or an uploaded media file,
produce a local audio file plus metadata,
reliably and repeatably, as the entry point to the whole pipeline. The user provides
only a link or a file.

## Current state

`extraction/extractor.py::extract_audio(url, ...)` does the link job: it uses the
`yt_dlp` Python API with `format="bestaudio/best"` and the `FFmpegExtractAudio`
postprocessor to go straight from a link to an MP3. Quality and format are parameters.
It runs in stages: `links.py` parses the link, finds the platform in the registry
(`platforms.py`), follows a share link (`instagram.com/share/…`, `fb.watch`, `t.co`) and
matches the link to one of the platform's single-post yt-dlp extractors (their own
`suitable()`); `compat.py` checks the platform against the active yt-dlp (extractor present
and working, version floor, Deno for YouTube, impersonation for Instagram); then come the
metadata (restricted to the platform's extractors), one media item picked from a
multi-media post, the limits, the download, and `finalize_source`. `check_link(text)` runs
the offline stages alone, for a check before a job starts.
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
  source_kind       platform id ("youtube", "instagram", "x", "facebook") | "upload"
  source_url        str?         # canonical URL; None for uploads
  original_filename str?         # uploaded file's name; None for links
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
  peak_dbfs         float?       # peak level of a link import; <= -70 dBFS is flagged silent
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
- **Failure modes.** `classify.py` maps yt-dlp's failures to typed errors in a fixed
  order: cookies that failed to load, the platform's own text rules (YouTube's bot check,
  Facebook's "Cannot parse data"), geo restriction, HTTP 429/404/410/5xx, yt-dlp's sign-in
  hint (`LoginRequiredError`), posts with no media, DRM, the older private/age/live/
  unavailable texts, network failures (`NetworkError`), a post that leads to another site,
  and finally an unforeseen extractor failure (`ExtractorOutdatedError`). Every error
  carries an `action` (`cookies`, `update_downloader`, `update_app`, `retry_later` or none)
  and the platform id, and its message names the platform.
- **Cookies.** `extract_audio(..., cookies_from_browser=, cookies_file=)` passes optional
  sign-in cookies to yt-dlp, for every platform: a browser profile (`cookiesfrombrowser`; the allow-list in
  `service/schemas.py` is chrome, edge, firefox, brave, chromium, vivaldi, opera, plus
  safari on macOS) or a Netscape cookies.txt file. The file is read into memory and given
  to yt-dlp as a stream, so it is never copied or written back. The service takes the
  choice from the preferences (`cookies_browser` / `cookies_file`) on each import. A
  source that can't be read fails with `CookiesError`.
- **Input validation.** Accept a link to one post (or a bare YouTube video ID). Other
  sites (`UnsupportedPlatformError`) and profiles, playlists, stories or photos
  (`UnsupportedLinkError`) are rejected before a job starts. A post with several videos
  imports its first one with audio, titled "(video 1 of N)"; an X link ending
  `/video/N` picks that one.
- **Working-copy normalization.** Produce a standardized PCM working file
  (e.g. 16 kHz mono WAV) for the detection layer regardless of source characteristics.

## Boundary

Extraction is **side-effecting** (network + filesystem). It must not perform analysis
or editing. Its only job: get the audio local, describe it, hand off an `AudioSource`.
