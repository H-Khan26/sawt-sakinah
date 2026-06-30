# sawt-sakinah

`sawt-sakinah` is a Quran recitation audio workflow centered on salah recordings. The product vision is simple: paste a YouTube link, extract the recitation audio, detect the parts that matter structurally, and let the user clean and navigate the recording without destructive editing.

At a high level, the app is designed to:

- extract audio from a YouTube URL into a local working artifact
- detect silent or relatively silent regions as structured data
- detect takbir and other prayer phrases as timeline markers
- derive prayer-position structure from those markers
- render user-selected cuts and exports as a new audio file

The architectural rule across the repo is: **detection returns data, editing produces files**. That separation is what supports the planned interactive frontend.

## Quickstart

`make` is the primary way to install and run the app. It requires [FFmpeg](https://ffmpeg.org/) on your `PATH` (a standalone binary, not a pip package) and GNU make (on Windows: `choco install make`, or run the targets from Git Bash / WSL).

```sh
make requirements   # install the package + service deps (editable)
make serve          # run the FastAPI service at http://127.0.0.1:8000
```

Optional analysis backends are separate extras (large downloads):

```sh
make requirements-phrases   # Whisper takbir/phrase detection
make requirements-vad       # Silero VAD silence detection (pulls torch)
make requirements-all        # everything
```

`make help` lists every target. For a quick one-shot with no server:

```sh
python -m sawt_sakinah extract "https://www.youtube.com/watch?v=..."
```

Operational settings (storage dirs, worker counts, ffmpeg path) accept `SAWT_*` environment variables or a `.env` file; all tuning knobs live in `sawt_sakinah/config/defaults.yaml`.

## Current Repo Shape

Today this repository is primarily a Python backend/audio-engine project, with frontend architecture docs alongside it.

- `sawt_sakinah/extraction/`: YouTube ingestion, validation, probing, normalization, hashing, and caching
- `sawt_sakinah/detection/`: silence detection, phrase detection, PCM decoding, loudness helpers, optional VAD path
- `sawt_sakinah/prayer/`: prayer-structure derivation from marker streams
- `sawt_sakinah/editing/`: silence removal and general EDL-based export rendering
- `sawt_sakinah/service/`: optional FastAPI service with async jobs, project storage, waveform peaks, media/export routes
- `docs/audio/`: audio-engine architecture and data-contract docs
- `docs/frontend/`: planned frontend architecture for the waveform editor

## Product Vision

The intended user flow is:

1. paste a YouTube link containing a Quran recitation or prayer recording
2. extract the audio and normalize it into a dependable working source
3. analyze the recording for silence-like gaps and spoken prayer phrases
4. show those segments and markers in a waveform editor
5. let the user select cuts or exports and render a cleaned result

The prayer-specific focus matters here: this is not a generic audio trimmer. The system is being shaped around recitation inside salah, where takbir, tasmi', tahmid, and tasleem help identify transitions between prayer positions and rak'ahs.

## Major Dependencies

### Core runtime

- **FFmpeg / ffprobe**: hard runtime dependency for extraction post-processing, probing, decoding, silence detection, waveform generation, and final audio rendering
- **yt-dlp**: YouTube extraction
- **Pydantic 2**: typed models and contracts
- **PyYAML**: config loading

These are the base install (`pip install -e .`, or `make requirements` which also adds the service stack).

### Optional service stack — `.[service]`

- **FastAPI**
- **Uvicorn**
- **pydantic-settings**
- **NumPy** for waveform peak generation

### Optional phrase-detection stack — `.[phrases]`

- **faster-whisper** for Arabic ASR with word timestamps
- **RapidFuzz** for normalized phrase matching against the transcript

### Optional VAD stack — `.[vad]`

- **Silero VAD**
- **ONNX Runtime**
- **torch / torchaudio** as pinned transitive support for the Silero package

All dependencies and these optional extras are declared in `pyproject.toml`; install them via the matching `make requirements-*` target.

## Models Underpinning It

The repo currently leans on two model-backed analysis paths:

- **Whisper-family phrase detection**: `sawt_sakinah.detection.phrases.detect_phrases()` uses `faster-whisper` for Arabic transcription with word timestamps, then matches canonical prayer phrases. The default model setting is a Whisper-style model such as `large-v3`, and the code is designed to allow a Quran-tuned drop-in model id as well.
- **Silero VAD silence detection**: `sawt_sakinah.detection.vad.detect_silence_vad()` treats silence as non-speech, which is a better fit than a pure dB gate for quiet dhikr and room noise.

The non-ML baseline remains important too:

- **FFmpeg `silencedetect`** is the default deterministic silence baseline
- **FFmpeg filtergraph rendering** underpins export and non-destructive edit application

## Frontend Direction

The frontend is planned, not yet implemented in this repo. The docs define a waveform editor built around:

- **SolidJS + TypeScript**
- **Vite**
- **Tailwind CSS**
- **@tanstack/solid-query**
- **wavesurfer.js v7** as the recommended waveform starting point
- **Tauri 2** as an optional desktop shell

The UI is intended to inherit visual patterns from `the base theme` and act as a control surface over the Python engine rather than duplicating analysis logic in the browser.

## Status

This repo already contains more than raw planning notes: extraction, silence detection, phrase detection, prayer-structure derivation, EDL-based export, and an optional async FastAPI service are present. The main missing piece is the user-facing frontend described in `docs/frontend/`.
