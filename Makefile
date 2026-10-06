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

# Desktop bundle (make bundle). Phase 1 builds Windows x64 only.
BUNDLE_PLATFORM ?= windows-x64
LOCK ?= packaging/requirements-windows.txt
BUILD_LOCK ?= packaging/requirements-build.txt
BUILD_DIR ?= packaging/build
DIST_DIR ?= packaging/dist
VENDOR_DIR ?= $(BUILD_DIR)/vendor
# Extra uv flags for `make lock`, e.g. LOCK_FLAGS=--upgrade or LOCK_FLAGS="-P yt-dlp".
LOCK_FLAGS ?=
LOCK_COMMON := --generate-hashes --emit-index-url --python-version 3.12 --python-platform x86_64-pc-windows-msvc

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
	'  make lock                  regenerate the hash-pinned release lock files (needs uv)\n'\
	'  make bundle                build the Windows desktop zip into packaging/dist\n'\
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

lock:  ## Regenerate the hash-pinned release lock files (CI builds install only these)
	$(UV) pip compile pyproject.toml --extra service --extra phrases --extra vad --extra desktop $(LOCK_COMMON) $(LOCK_FLAGS) -o $(LOCK)
	$(UV) pip compile packaging/requirements-build.in -c $(LOCK) $(LOCK_COMMON) $(LOCK_FLAGS) -o $(BUILD_LOCK)

bundle:  ## Build the desktop zip: SPA, helper binaries, PyInstaller, notices (needs requirements-bundle)
	cd frontend && npm ci && npm run build
	$(PYTHON) packaging/fetch_binaries.py $(BUNDLE_PLATFORM) $(VENDOR_DIR)
	$(PYTHON) -m PyInstaller --noconfirm --clean --distpath $(DIST_DIR) --workpath $(BUILD_DIR)/pyinstaller packaging/sawt_sakinah.spec
	$(PYTHON) packaging/third_party.py frontend frontend -o $(BUILD_DIR)/frontend-licenses.txt
	$(PYTHON) packaging/third_party.py bundle --lock $(LOCK) --vendor $(VENDOR_DIR) --spa frontend/dist --frontend-notices $(BUILD_DIR)/frontend-licenses.txt -o $(BUILD_DIR)/THIRD_PARTY_LICENSES.txt
	$(PYTHON) packaging/package.py --dist $(DIST_DIR)/SawtSakinah --platform $(BUNDLE_PLATFORM) --notices $(BUILD_DIR)/THIRD_PARTY_LICENSES.txt --out $(DIST_DIR)

clean:  ## Remove __pycache__, build artifacts, and egg-info
	$(PYTHON) -c "import shutil, glob; [shutil.rmtree(p, ignore_errors=True) for p in glob.glob('**/__pycache__', recursive=True) + glob.glob('*.egg-info') + ['build', 'dist', 'packaging/build', 'packaging/dist']]"
