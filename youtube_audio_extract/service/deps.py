"""FastAPI dependencies exposing the app-scoped singletons (set up in ``app.lifespan``)."""

from __future__ import annotations

from fastapi import Request

from .jobs import JobRegistry
from .projects import ProjectStore
from .settings import ServiceSettings


def get_settings(request: Request) -> ServiceSettings:
    return request.app.state.settings


def get_store(request: Request) -> ProjectStore:
    return request.app.state.store


def get_jobs(request: Request) -> JobRegistry:
    return request.app.state.jobs
