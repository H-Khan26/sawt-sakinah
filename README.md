<p align="center">
  <img src="docs/assets/wordmark.png" alt="Sawt Sakinah" width="520">
</p>

<p align="center">
  A non-destructive editor for salah and Quran recitation recordings.<br>
  Paste a YouTube link or drop in a file, find the silences and the takbirs, cut what you do not need, export.
</p>

## What it does

- **Acquires** audio from a YouTube URL or an uploaded file and keeps a 16 kHz working copy per project.
- **Detects silence** with Silero voice-activity detection, so quiet dhikr and room noise are treated as non-speech rather than as recitation. An ffmpeg energy gate remains available as a fallback.
- **Detects prayer phrases** (takbir, tasmi', tahmid, tasleem) with Whisper and turns them into timeline markers, then derives the rak'ah and position outline from the marker stream.
- **Edits non-destructively.** Cuts, keeps and markers live in an edit decision list. The waveform collapses cut audio out of view, and nothing is rendered until you export.
- **Exports** the edited result, or a selected range, with chapter markers embedded. A range can also be split off into its own project.

Detection returns data; only export writes audio. That rule shapes every module in the repo.

## Download

Sawt Sakinah runs on your own computer, and your recordings stay on it.

1. Download `SawtSakinah-<version>-windows-x64.zip` from the
   [latest release](https://github.com/H-Khan26/sawt-sakinah/releases/latest).
2. Unzip it anywhere you like (for example `Documents\SawtSakinah`) and run
   `SawtSakinah.exe` in the unzipped folder.
3. The app is not code-signed yet, so Windows SmartScreen stops the first launch. Choose
   **More info**, then **Run anyway**.

The window uses Microsoft Edge WebView2, which Windows 10 and 11 already include. If the
window stays blank, install the
[WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/).

The speech model for phrase detection is not in the zip. The app downloads it (about
1.6 GB) the first time you run phrase detection, and keeps it for later. Phrase detection
runs on the CPU and takes a few minutes per recording; silence detection and editing are
quick.

| | Minimum | Recommended |
|---|---|---|
| System | Windows 10 22H2 or Windows 11, 64-bit (x64) | |
| CPU | 4 cores, x86-64 with AVX2 | 8 cores or more |
| Memory | 8 GB | 16 GB |
| Disk | 5 GB free (app, speech model, projects) | |
| GPU | Not used | |
| Network | For YouTube imports and the one-time model download | |

### Verify the download

Each release zip carries a signed build-provenance attestation, made by the release
workflow in this repository. With the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify SawtSakinah-<version>-windows-x64.zip -R H-Khan26/sawt-sakinah
```

Or compare the file's SHA-256 (`Get-FileHash <zip>` in PowerShell) with `SHA256SUMS` on
the release page.

### Your data and updates

Projects, the speech model, settings and logs live in
`%LOCALAPPDATA%\SawtSakinah`, outside the app folder. To update, delete the old app
folder and unzip the new release in its place; your projects stay where they are.

### What goes over the network

- **YouTube**, when you import a video by its URL.
- **Hugging Face**, to download the speech model once.
- **GitHub API**, to check for a newer release. This is on by default and can be turned
  off in the app's settings.

There is no telemetry, no account and no analytics.

Downloading from YouTube is something you do yourself, on your own machine. Make sure it
is allowed for the video you import, under
[YouTube's Terms of Service](https://www.youtube.com/t/terms) and the rights of whoever
made the recording.

## How it works

```
 YouTube / file ──> extraction ──> mp3 + working copy + speech map ──┐
                                                                    │
            ┌────────────── detection (read-only) ──────────────────┘
            │  silence:  speech map ──> spans ──> gaps >= 3 s
            │  phrases:  speech clips ──> Whisper ──> fuzzy match ──> markers
            │  prayer:   markers ──> positions / rak'ahs
            ▼
      edit decision list  (cut / keep / marker, built in the UI)
            │
            ▼
        editing (ffmpeg render) ──> exported audio + chapters
```

The speech map is a per-frame speech-probability track computed once when a source is
acquired. Every later silence re-detect is a numpy threshold over that track, so the
speech-threshold slider responds instantly, and phrase detection transcribes only the
speech it describes.

## Configuration

Every tuning knob lives in one strictly validated file, `sawt_sakinah/config/defaults.yaml`
(silence thresholds, VAD sensitivity, Whisper model, export format). Point
`SAWT_CONFIG_FILE` at a copy to override the whole set. Operational settings such as
storage directories, worker counts and the ffmpeg path accept `SAWT_*` environment
variables or a `.env` file.

## Run from source

Prerequisites: Python 3.10+, [FFmpeg](https://ffmpeg.org/) (ffmpeg and ffprobe on `PATH`), [Deno](https://deno.com/) 2.3+ on `PATH` (yt-dlp uses it for YouTube), [Node.js](https://nodejs.org/), and GNU make (on Windows: `choco install make`, or use Git Bash or WSL).

```sh
make requirements   # pip install -e ".[service,phrases,vad,desktop]"
make dev            # backend http://127.0.0.1:38427 + frontend http://localhost:38428, hot reload
make desktop        # build the frontend and open the app in a native window
```

`make help` lists every target. The Whisper model downloads on first phrase detection (about 1.6 GB for the default `large-v3-turbo`).

One-shot extraction with silence removal, no server:

```sh
python -m sawt_sakinah extract "https://www.youtube.com/watch?v=..."
```

To build the Windows zip yourself, in a fresh virtual environment:

```sh
make requirements-bundle   # hash-pinned release dependencies + PyInstaller
make bundle                # SPA, ffmpeg/Deno download, PyInstaller, zip -> packaging/dist/
```

`make lock` regenerates the pinned lock files in `packaging/` after a dependency change.

## Repository layout

```
sawt_sakinah/
  config/       defaults.yaml + strict schema (the single source of tuning knobs)
  models/       pydantic contracts shared by every layer
  extraction/   YouTube download, file import, working copy, speech map, cache
  detection/    silence (VAD / ffmpeg), phrases (Whisper), Silero ONNX asset
  prayer/       prayer-position state machine over the marker stream
  editing/      EDL render and export (the only layer that writes audio)
  service/      FastAPI app, job pools, project store, routes
frontend/       React 18 + TypeScript + Vite + Tailwind + TanStack Query, wavesurfer.js
docs/           architecture (audio/, frontend/), design records (plans/), README assets
packaging/      desktop bundle: PyInstaller spec, lock files, helper-binary manifest
.github/        CI, release and weekly rebuild workflows
scripts/dev.py  runs backend and frontend together
```

## Documentation

Start at [docs/README.md](docs/README.md) for the architecture map, then the audio-engine
and frontend documents it links. Design records for larger changes are kept in
[docs/plans/](docs/plans/).

## License

[MIT](LICENSE). Bundled third-party assets keep their own licenses: the Silero VAD model
(MIT, `sawt_sakinah/detection/assets/SILERO_LICENSE`) and the webfonts (SIL OFL,
`frontend/public/fonts/`). The Windows release also ships FFmpeg (LGPL build), Deno (MIT)
and the Python packages it runs on; `THIRD_PARTY_LICENSES.txt` in the zip lists each one
with its license text and source link.
