# sawt-sakinah

`sawt-sakinah` is a Quran recitation audio workflow centered on salah recordings. The product vision is simple: paste a YouTube link, extract the recitation audio, detect the parts that matter structurally, and let the user clean and navigate the recording without destructive editing.

At a high level, the app is designed to:

- extract audio from a YouTube URL into a local working artifact
- detect silent or relatively silent regions as structured data
- detect takbir and other prayer phrases as timeline markers
- derive prayer-position structure from those markers
- render user-selected cuts and exports as a new audio file

The architectural rule across the repo is: **detection returns data, editing produces files**. That separation is what supports the planned interactive frontend.

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

Base install lives in `requirements.txt`.

### Optional service stack

- **FastAPI**
- **Uvicorn**
- **pydantic-settings**
- **NumPy** for waveform peak generation

These live in `requirements-service.txt`.

### Optional phrase-detection stack

- **faster-whisper** for Arabic ASR with word timestamps
- **RapidFuzz** for normalized phrase matching against the transcript

These live in `requirements-phrases.txt`.

### Optional VAD stack

- **Silero VAD**
- **ONNX Runtime**
- **torch / torchaudio** as pinned transitive support for the Silero package

These live in `requirements-vad.txt`.

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
