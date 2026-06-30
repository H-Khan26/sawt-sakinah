"""FastAPI service layer for the audio engine.

Imported only when running the server, so ``import sawt_sakinah`` stays free of
web dependencies. Entry point::

    uvicorn sawt_sakinah.service.app:app

See docs/audio/05-data-model-and-api.md.
"""
