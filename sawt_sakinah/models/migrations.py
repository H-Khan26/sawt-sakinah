"""``project.json`` format versions and the steps that bring older files forward.

:data:`SCHEMA_VERSION` is the version this app writes. :func:`migrate` takes the parsed
JSON of a project file, applies each registered step from the file's version up to the
current one and returns the upgraded dict, stamped with the current version. A file
without ``schema_version`` predates versioning and counts as version 0.

A file from a newer app is refused with :class:`ProjectTooNewError` rather than loaded:
this app can't know what it would drop by rewriting it in its own, older format. Steps are
pure functions of the dict, so the store decides when the upgraded form is written back
(on the next save).
"""

from __future__ import annotations

from typing import Callable

from .errors import ProjectTooNewError, ProjectUnreadableError

#: The ``project.json`` format this app reads and writes.
SCHEMA_VERSION = 2

TOO_NEW_MESSAGE = (
    "This recording was saved by a newer version of Sawt Sakinah. Update the app to open it."
)


def _v0_to_v1(raw: dict) -> dict:
    """Fill fields that files from before versioning may lack.

    Identity and timestamps came later than the first projects: the library label falls
    back to the source title, ``created_at`` to the source's, ``updated_at`` to
    ``created_at``. Very early sources also lack ``source_kind``; they were all downloads.
    """
    src = raw.get("audio_source")
    if isinstance(src, dict):
        if not src.get("source_kind"):
            src = {**src, "source_kind": "youtube"}
            raw["audio_source"] = src
    else:
        src = {}
    src_created = src.get("created_at")
    if not raw.get("name"):
        raw["name"] = src.get("title") or ""
    if not raw.get("created_at") and src_created:
        raw["created_at"] = src_created
    if not raw.get("updated_at"):
        raw["updated_at"] = raw.get("created_at") or src_created
    return raw


def _v1_to_v2(raw: dict) -> dict:
    """Drop the phrase markers and the prayer outline, which the surah map replaced."""
    raw.pop("markers", None)
    raw.pop("structure", None)
    return raw


#: ``version -> step`` upgrading a version-``n`` dict to ``n + 1``.
_STEPS: dict[int, Callable[[dict], dict]] = {0: _v0_to_v1, 1: _v1_to_v2}


def migrate(raw: object) -> dict:
    """Upgrade a parsed ``project.json`` to :data:`SCHEMA_VERSION`; returns a new dict.

    Raises:
        ProjectTooNewError: If the file was written by a newer app version.
        ProjectUnreadableError: If the file is not a JSON object or its version is invalid.
    """
    if not isinstance(raw, dict):
        raise ProjectUnreadableError("Its data file is damaged (not a JSON object).")
    version = raw.get("schema_version", 0)
    if type(version) is not int or version < 0:
        raise ProjectUnreadableError("Its data file has an invalid schema_version.")
    if version > SCHEMA_VERSION:
        raise ProjectTooNewError(TOO_NEW_MESSAGE)
    data = dict(raw)
    while version < SCHEMA_VERSION:
        data = _STEPS[version](data)
        version += 1
    data["schema_version"] = SCHEMA_VERSION
    return data


__all__ = ["SCHEMA_VERSION", "TOO_NEW_MESSAGE", "migrate"]
