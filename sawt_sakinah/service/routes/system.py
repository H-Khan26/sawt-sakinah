"""App-level endpoints under ``/app``: version info, preferences, the update check, the
logs folder, the export folder, and bringing the desktop window to the front."""

from __future__ import annotations

from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ValidationError

from ... import __version__, runtime
from ...applog import open_folder
from ...detection import quran
from .. import export_folder
from ..preferences import Preferences, PreferencesPatch, load_preferences, update_preferences
from ..schemas import check_export_dir, cookie_browsers
from ..updates import UpdateStatus, check_for_update
from .ytdlp import preference_changed

router = APIRouter(prefix="/app", tags=["app"])


class AppInfo(BaseModel):
    version: str
    frozen: bool
    cookie_browsers: list[str]  # browsers offered for YouTube cookies on this OS
    export_to_folder: bool  # exports are saved to a folder (desktop) instead of downloaded
    default_export_dir: Optional[str] = None  # the Downloads folder, when saving to a folder
    quran_text_credit: str = quran.CREDIT  # attribution the Tanzil terms ask for


@router.get("/info", response_model=AppInfo)
def app_info(request: Request) -> AppInfo:
    to_folder = request.app.state.settings.export_to_folder
    return AppInfo(
        version=__version__,
        frozen=runtime.FROZEN,
        cookie_browsers=cookie_browsers(),
        export_to_folder=to_folder,
        default_export_dir=str(export_folder.default_export_dir()) if to_folder else None,
    )


def _save(changes: dict) -> Preferences:
    try:
        return update_preferences(changes)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_url=False, include_context=False))
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"could not save preferences: {exc}")


@router.get("/preferences", response_model=Preferences)
def get_preferences() -> Preferences:
    return load_preferences()


@router.patch("/preferences", response_model=Preferences)
def patch_preferences(patch: PreferencesPatch, request: Request) -> Preferences:
    """Apply the sent keys and return the full, stored preferences."""
    changes = patch.changes()
    saved = _save(changes)
    if "ytdlp_update" in changes:
        preference_changed(request.app, saved.ytdlp_update)
    return saved


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


@router.post("/export-folder/pick", response_model=Preferences)
def pick_export_folder(request: Request) -> Preferences:
    """Let the user choose the export folder in a native dialog; returns the preferences
    (unchanged when the dialog is cancelled). Choosing Downloads stores the default."""
    pick = getattr(request.app.state, "pick_folder", None)
    if pick is None:
        raise HTTPException(status_code=404, detail="no window to show a folder dialog in")
    current = export_folder.export_dir(load_preferences().export_dir)
    chosen = pick(current)
    if not chosen:
        return load_preferences()
    try:
        check_export_dir(chosen)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    is_default = Path(chosen) == export_folder.default_export_dir()
    return _save({"export_dir": None if is_default else chosen})


@router.post("/export-folder/open", status_code=204)
def open_export_folder() -> Response:
    """Show the export folder in the OS file manager."""
    chosen = load_preferences().export_dir
    folder = export_folder.export_dir(chosen)
    if chosen is not None and not folder.is_dir():
        raise HTTPException(status_code=404, detail=f"{folder} isn't available")
    try:
        open_folder(folder)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"could not open the export folder: {exc}")
    return Response(status_code=204)


@router.post("/focus", status_code=204, include_in_schema=False)
def focus_window(request: Request) -> Response:
    """Bring the desktop window to the front (a second app launch calls this)."""
    focus = getattr(request.app.state, "focus_window", None)
    if focus is None:
        raise HTTPException(status_code=404, detail="no window to focus")
    focus()
    return Response(status_code=204)
