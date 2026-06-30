"""FastAPI service layer for the audio engine.

Imported only when running the server, so ``import youtube_audio_extract`` stays free of
web dependencies. Entry point::

    uvicorn youtube_audio_extract.service.app:app

See docs/audio/05-data-model-and-api.md.
"""
