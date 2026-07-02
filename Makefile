# Primary entry point for sawt-sakinah.
#
# Requires GNU make. On Windows install it with `choco install make` (or run from
# Git Bash / WSL). Override the interpreter or bind address as needed, e.g.:
#   make dev PORT=9000
#   make requirements PYTHON=py

PYTHON ?= python
PIP := $(PYTHON) -m pip
HOST ?= 127.0.0.1
PORT ?= 8000

.DEFAULT_GOAL := help
.PHONY: help requirements requirements-phrases requirements-vad requirements-all requirements-desktop dev desktop clean

help:  ## List available commands
	@$(PYTHON) -c "print('Commands:\n'\
	'  make requirements          install everything to run the app (service + phrases + desktop; no VAD)\n'\
	'  make requirements-phrases  just the Whisper phrase detection deps (faster-whisper)\n'\
	'  make requirements-vad      add the Silero VAD silence detector (heavy: torch)\n'\
	'  make requirements-desktop  just the pywebview desktop shell\n'\
	'  make requirements-all      absolutely everything, including VAD/torch\n'\
	'  make dev                   develop: backend (autoreload) + frontend, hot reload\n'\
	'  make desktop               run the app: build the SPA + open the native window\n'\
	'  make clean                 remove caches and build artifacts')"

requirements:  ## Install everything to run the app (service + phrases + desktop; no VAD)
	$(PIP) install -e ".[service,phrases,desktop]"

requirements-phrases:  ## Install just the Whisper phrase-detection deps
	$(PIP) install -e ".[phrases]"

requirements-vad:  ## Install the Silero VAD silence detector (heavy: torch)
	$(PIP) install -e ".[vad]"

requirements-desktop:  ## Install just the pywebview desktop shell (needs service too)
	$(PIP) install -e ".[service,desktop]"

requirements-all:  ## Install absolutely everything, including VAD/torch
	$(PIP) install -e ".[all,desktop]"

dev:  ## Develop: backend (autoreload) + frontend dev server together, hot reload
	$(PYTHON) scripts/dev.py --host $(HOST) --port $(PORT)

desktop:  ## Run the app: build the SPA, then open it in a native window (needs [desktop])
	cd frontend && npm run build
	$(PYTHON) -m sawt_sakinah desktop --host $(HOST) --port $(PORT)

clean:  ## Remove __pycache__, build artifacts, and egg-info
	$(PYTHON) -c "import shutil, glob; [shutil.rmtree(p, ignore_errors=True) for p in glob.glob('**/__pycache__', recursive=True) + glob.glob('*.egg-info') + ['build', 'dist']]"
