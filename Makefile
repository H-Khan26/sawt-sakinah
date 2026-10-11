# Primary entry point for sawt-sakinah.
#
# Requires GNU make. On Windows install it with `choco install make` (or run from
# Git Bash / WSL). Override the interpreter or bind address as needed, e.g.:
#   make dev PORT=9000
#   make requirements PYTHON=py

PYTHON ?= python
PIP := $(PYTHON) -m pip
UV ?= uv
HOST ?= 127.0.0.1
PORT ?= 38427

# Desktop bundle (make bundle): Windows x64 by default; on a Mac use
#   make requirements-bundle bundle BUNDLE_PLATFORM=macos-arm64
BUNDLE_PLATFORM ?= windows-x64
WINDOWS_LOCK := packaging/requirements-windows.txt
WINDOWS_BUILD_LOCK := packaging/requirements-build.txt
MACOS_LOCK := packaging/requirements-macos.txt
MACOS_BUILD_LOCK := packaging/requirements-build-macos.txt
ifeq ($(BUNDLE_PLATFORM),macos-arm64)
LOCK ?= $(MACOS_LOCK)
BUILD_LOCK ?= $(MACOS_BUILD_LOCK)
BUNDLE_APP ?= SawtSakinah.app
else
LOCK ?= $(WINDOWS_LOCK)
BUILD_LOCK ?= $(WINDOWS_BUILD_LOCK)
BUNDLE_APP ?= SawtSakinah
endif
BUILD_DIR ?= packaging/build
DIST_DIR ?= packaging/dist
VENDOR_DIR ?= $(BUILD_DIR)/vendor
# Extra uv flags for `make lock`, e.g. LOCK_FLAGS=--upgrade or LOCK_FLAGS="-P yt-dlp".
LOCK_FLAGS ?=
LOCK_COMMON := --generate-hashes --emit-index-url --python-version 3.12
LOCK_EXTRAS := --extra service --extra phrases --extra vad --extra desktop
LOCK_WINDOWS := $(LOCK_COMMON) --python-platform x86_64-pc-windows-msvc
LOCK_MACOS := $(LOCK_COMMON) --python-platform aarch64-apple-darwin

.DEFAULT_GOAL := help
.PHONY: help requirements requirements-phrases requirements-vad requirements-all requirements-desktop requirements-bundle dev desktop lock bundle clean

help:  ## List available commands
	@$(PYTHON) -c "print('Commands:\n'\
	'  make requirements          install everything to run the app (service + phrases + vad + desktop)\n'\
	'  make requirements-phrases  just the Whisper phrase detection deps (faster-whisper)\n'\
	'  make requirements-vad      just the Silero VAD speech detector (numpy + onnxruntime; no torch)\n'\
	'  make requirements-desktop  just the pywebview desktop shell\n'\
	'  make requirements-all      every extra, including the desktop shell (same set as requirements)\n'\
	'  make requirements-bundle   the hash-pinned release set + PyInstaller (use a fresh venv)\n'\
	'  make dev                   develop: backend (autoreload) + frontend, hot reload\n'\
	'  make desktop               run the app: build the SPA + open the native window\n'\
	'  make lock                  regenerate the Windows and macOS release lock files (needs uv)\n'\
	'  make bundle                build the Windows zip into packaging/dist (Mac: BUNDLE_PLATFORM=macos-arm64)\n'\
	'  make clean                 remove caches and build artifacts')"

requirements:  ## Install everything to run the app (service + phrases + vad + desktop)
	$(PIP) install -e ".[service,phrases,vad,desktop]"

requirements-phrases:  ## Install just the Whisper phrase-detection deps
	$(PIP) install -e ".[phrases]"

requirements-vad:  ## Install just the Silero VAD speech detector (numpy + onnxruntime; no torch)
	$(PIP) install -e ".[vad]"

requirements-desktop:  ## Install just the pywebview desktop shell (needs service too)
	$(PIP) install -e ".[service,desktop]"

requirements-all:  ## Install every extra, including the desktop shell
	$(PIP) install -e ".[all,desktop]"

requirements-bundle:  ## Install the hash-pinned release set plus PyInstaller (same as CI)
	$(PIP) install --require-hashes --only-binary :all: -r $(BUILD_LOCK)
	$(PIP) install --require-hashes --no-build-isolation -r $(LOCK)

dev:  ## Develop: backend (autoreload) + frontend dev server together, hot reload
	$(PYTHON) scripts/dev.py --host $(HOST) --port $(PORT)

desktop:  ## Run the app: build the SPA, then open it in a native window (needs [desktop])
	cd frontend && npm run build
	$(PYTHON) -m sawt_sakinah desktop --host $(HOST)

# The macOS locks take the Windows pins as constraints, so both platforms ship the same
# versions; uv resolves macOS wheels for the app's minimum macOS (onnxruntime needs 14).
lock: export MACOSX_DEPLOYMENT_TARGET = 14.0
lock:  ## Regenerate the hash-pinned release lock files (CI builds install only these)
	$(UV) pip compile pyproject.toml $(LOCK_EXTRAS) $(LOCK_WINDOWS) $(LOCK_FLAGS) -o $(WINDOWS_LOCK)
	$(UV) pip compile packaging/requirements-build.in -c $(WINDOWS_LOCK) $(LOCK_WINDOWS) $(LOCK_FLAGS) -o $(WINDOWS_BUILD_LOCK)
	$(UV) pip compile pyproject.toml $(LOCK_EXTRAS) -c $(WINDOWS_LOCK) $(LOCK_MACOS) $(LOCK_FLAGS) -o $(MACOS_LOCK)
	$(UV) pip compile packaging/requirements-build.in -c $(MACOS_LOCK) -c $(WINDOWS_BUILD_LOCK) $(LOCK_MACOS) $(LOCK_FLAGS) -o $(MACOS_BUILD_LOCK)

# The notices come before PyInstaller: the macOS spec seals them inside the .app.
bundle: export SAWT_VENDOR_DIR = $(abspath $(VENDOR_DIR))
bundle: export SAWT_NOTICES = $(abspath $(BUILD_DIR)/THIRD_PARTY_LICENSES.txt)
bundle:  ## Build the desktop zip: SPA, helper binaries, notices, PyInstaller (needs requirements-bundle)
	cd frontend && npm ci && npm run build
	$(PYTHON) packaging/fetch_binaries.py $(BUNDLE_PLATFORM) $(VENDOR_DIR)
	$(PYTHON) packaging/third_party.py frontend frontend -o $(BUILD_DIR)/frontend-licenses.txt
	$(PYTHON) packaging/third_party.py bundle --lock $(LOCK) --vendor $(VENDOR_DIR) --spa frontend/dist --frontend-notices $(BUILD_DIR)/frontend-licenses.txt -o $(BUILD_DIR)/THIRD_PARTY_LICENSES.txt
	$(PYTHON) -m PyInstaller --noconfirm --clean --distpath $(DIST_DIR) --workpath $(BUILD_DIR)/pyinstaller packaging/sawt_sakinah.spec
	$(PYTHON) packaging/package.py --dist $(DIST_DIR)/$(BUNDLE_APP) --platform $(BUNDLE_PLATFORM) --notices $(BUILD_DIR)/THIRD_PARTY_LICENSES.txt --out $(DIST_DIR)

clean:  ## Remove __pycache__, build artifacts, and egg-info
	$(PYTHON) -c "import shutil, glob; [shutil.rmtree(p, ignore_errors=True) for p in glob.glob('**/__pycache__', recursive=True) + glob.glob('*.egg-info') + ['build', 'dist', 'packaging/build', 'packaging/dist']]"
