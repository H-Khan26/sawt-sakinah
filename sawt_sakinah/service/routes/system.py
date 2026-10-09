"""App-level endpoints under ``/app``: version info, preferences, the update check, the
logs folder, and bringing the desktop window to the front."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ValidationError

from ... import __version__, runtime
from ...applog import open_folder
from ..preferences import Preferences, PreferencesPatch, load_preferences, update_preferences
from ..updates import UpdateStatus, check_for_update

router = APIRouter(prefix="/app", tags=["app"])


class AppInfo(BaseModel):
    version: str
    frozen: bool


@router.get("/info", response_model=AppInfo)
def app_info() -> AppInfo:
    return AppInfo(version=__version__, frozen=runtime.FROZEN)


@router.get("/preferences", response_model=Preferences)
def get_preferences() -> Preferences:
    return load_preferences()


@router.patch("/preferences", response_model=Preferences)
def patch_preferences(patch: PreferencesPatch) -> Preferences:
    """Apply the sent keys and return the full, stored preferences."""
    try:
        return update_preferences(patch.changes())
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_url=False, include_context=False))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"could not save preferences: {exc}")


@router.get("/update", response_model=UpdateStatus)
def get_update() -> UpdateStatus:
    """Whether a newer release exists. Checks GitHub at most once a day; never fails."""
    return check_for_update()


@router.post("/open-logs", status_code=204)
def open_logs() -> Response:
    """Show the logs folder in the OS file manager."""
    try:
        open_folder(runtime.logs_dir())
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"could not open the logs folder: {exc}")
    return Response(status_code=204)


@router.post("/focus", status_code=204, include_in_schema=False)
def focus_window(request: Request) -> Response:
    """Bring the desktop window to the front (a second app launch calls this)."""
    focus = getattr(request.app.state, "focus_window", None)
    if focus is None:
        raise HTTPException(status_code=404, detail="no window to focus")
    focus()
    return Response(status_code=204)
