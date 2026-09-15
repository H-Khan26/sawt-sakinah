"""FastAPI application factory: wiring, lifespan, and error mapping.

Run with::

    uvicorn sawt_sakinah.service.app:app

The store and job registry are created in the lifespan and attached to ``app.state``
(read via ``deps.py``). The extraction error hierarchy is mapped to HTTP status codes for
the rare synchronous failure; async failures surface in ``JobRecord.error``/``error_type``.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from ..models import (
    AgeRestrictedError,
    ExtractionError,
    FileTooLargeError,
    InvalidInputError,
    LiveStreamError,
    NoAudioStreamError,
    PrivateVideoError,
    RegionLockedError,
    UnsupportedMediaError,
    VideoUnavailableError,
)
from .jobs import JobRegistry
from .projects import ProjectStore
from .routes import detect, export, jobs, media, projects
from .settings import ServiceSettings

# Most specific first; Starlette resolves by the closest match in the exception's MRO.
_ERROR_STATUS: list[tuple[type[Exception], int]] = [
    (InvalidInputError, 400),
    (PrivateVideoError, 403),
    (AgeRestrictedError, 403),
    (RegionLockedError, 451),
    (LiveStreamError, 422),
    (VideoUnavailableError, 404),
    (UnsupportedMediaError, 415),
    (NoAudioStreamError, 422),
    (FileTooLargeError, 413),
    (ExtractionError, 502),
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings: ServiceSettings = app.state.settings
    app.state.store = ProjectStore(settings.projects_dir)
    app.state.jobs = JobRegistry(settings.max_workers, settings.phrase_workers)
    try:
        yield
    finally:
        app.state.jobs.shutdown()


def _make_handler(status: int):
    async def handler(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=status,
            content={"error": type(exc).__name__, "detail": str(exc)},
        )

    return handler


def _mount_spa(app: FastAPI, dist: Path) -> None:
    """Serve the built SPA at ``/`` with a deep-link catch-all.

    Registered *after* the API routers so those always win; the catch-all only handles GETs
    no API route claimed. Hashed assets are served by ``StaticFiles`` (proper caching); any
    other path serves the real file if it exists (favicon, etc.), else ``index.html`` so
    React Router deep links like ``/p/<id>`` resolve. Path traversal outside ``dist`` falls
    back to the shell rather than escaping the directory.
    """
    dist = dist.resolve()
    index = dist / "index.html"
    assets = dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa_catch_all(full_path: str) -> FileResponse:
        candidate = (dist / full_path).resolve()
        if full_path and candidate.is_file() and candidate.is_relative_to(dist):
            return FileResponse(candidate)
        return FileResponse(index)


def create_app(settings: Optional[ServiceSettings] = None) -> FastAPI:
    app = FastAPI(title="sawt-sakinah service", lifespan=lifespan)
    app.state.settings = settings or ServiceSettings()

    for router in (
        projects.router,
        jobs.router,
        detect.router,
        media.router,
        export.router,
    ):
        app.include_router(router)

    for exc_type, status in _ERROR_STATUS:
        app.add_exception_handler(exc_type, _make_handler(status))

    # Serve the built SPA last so API routes take precedence. Skipped when unbuilt (dev uses
    # the Vite server), leaving the API-only app untouched.
    static_dir = app.state.settings.static_dir
    if static_dir is not None and Path(static_dir).is_dir():
        _mount_spa(app, Path(static_dir))

    return app


app = create_app()
