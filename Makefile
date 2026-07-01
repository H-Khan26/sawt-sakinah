# Primary entry point for sawt-sakinah.
#
# Requires GNU make. On Windows install it with `choco install make` (or run from
# Git Bash / WSL). Override the interpreter or bind address as needed, e.g.:
#   make serve PORT=9000
#   make requirements PYTHON=py

PYTHON ?= python
PIP := $(PYTHON) -m pip
HOST ?= 127.0.0.1
PORT ?= 8000

.DEFAULT_GOAL := help
.PHONY: help requirements requirements-phrases requirements-vad requirements-all serve dev dev-api clean

help:  ## List available commands
	@$(PYTHON) -c "print('Commands:\n'\
	'  make requirements          install core + service deps (run the app)\n'\
	'  make requirements-phrases  + Whisper phrase detection (faster-whisper)\n'\
	'  make requirements-vad      + Silero VAD silence detection (torch)\n'\
	'  make requirements-all      everything\n'\
	'  make serve                 run the service at http://$(HOST):$(PORT)\n'\
	'  make dev                   run backend (autoreload) + frontend together\n'\
	'  make dev-api               run only the service with autoreload\n'\
	'  make clean                 remove caches and build artifacts')"

requirements:  ## Install core + service deps (enough to run the app)
	$(PIP) install -e ".[service]"

requirements-phrases:  ## Install optional Whisper phrase-detection deps
	$(PIP) install -e ".[phrases]"

requirements-vad:  ## Install optional Silero VAD deps
	$(PIP) install -e ".[vad]"

requirements-all:  ## Install everything (service + phrases + vad)
	$(PIP) install -e ".[all]"

serve:  ## Run the FastAPI service (the app)
	$(PYTHON) -m sawt_sakinah serve --host $(HOST) --port $(PORT)

dev:  ## Run backend (autoreload) + frontend dev server together
	$(PYTHON) scripts/dev.py --host $(HOST) --port $(PORT)

dev-api:  ## Run only the service with autoreload
	$(PYTHON) -m sawt_sakinah serve --host $(HOST) --port $(PORT) --reload

clean:  ## Remove __pycache__, build artifacts, and egg-info
	$(PYTHON) -c "import shutil, glob; [shutil.rmtree(p, ignore_errors=True) for p in glob.glob('**/__pycache__', recursive=True) + glob.glob('*.egg-info') + ['build', 'dist']]"
