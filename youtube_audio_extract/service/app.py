"""FastAPI application factory: wiring, lifespan, and error mapping.

Run with::

    uvicorn youtube_audio_extract.service.app:app

The store and job registry are created in the lifespan and attached to ``app.state``
(read via ``deps.py``). The extraction error hierarchy is mapped to HTTP status codes for
the rare synchronous failure; async failures surface in ``JobRecord.error``/``error_type``.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from ..models import (
    AgeRestrictedError,
    ExtractionError,
    InvalidInputError,
    LiveStreamError,
    PrivateVideoError,
    RegionLockedError,
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


def create_app(settings: Optional[ServiceSettings] = None) -> FastAPI:
    app = FastAPI(title="youtube_audio_extract service", lifespan=lifespan)
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

    return app


app = create_app()
