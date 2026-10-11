"""Request guards for the local API.

The service listens on localhost, so any web page the user visits can try to reach it.
``install_guards`` closes the two ways in:

* **DNS rebinding** -- ``TrustedHostMiddleware`` rejects any ``Host`` header that is not a
  local name, so a hostile domain re-pointed at ``127.0.0.1`` gets a 400.
* **Cross-site requests** -- ``LocalGuard`` rejects any request the browser marks
  ``Sec-Fetch-Site: cross-site`` and any state-changing request whose ``Origin`` is not
  this service (or an explicitly allowed dev origin), requires the per-launch token when
  one is configured, and refuses oversized uploads from ``Content-Length`` before
  Starlette spools the body. Every other request body is capped at ``MAX_BODY_BYTES``:
  a larger ``Content-Length`` is refused up front, and a body without one (chunked) is
  read up to the cap before the app sees it.

The token is presented as the ``X-Sawt-Token`` header or as an HttpOnly, SameSite=Strict
session cookie. The desktop window gets the cookie by first loading
``/_session?token=<token>``, which sets it and redirects to ``/``; from then on fetches,
``<audio>`` sources and download links all carry it automatically.
"""

from __future__ import annotations

import json
import re
import secrets
from typing import Optional
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI
from starlette.datastructures import Headers
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import cookie_parser
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from ..config import CONFIG

TOKEN_HEADER = "x-sawt-token"
SESSION_PATH = "/_session"
UPLOAD_PATH = "/projects/upload"
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
_DIGITS = re.compile(r"[0-9]+")
# Headroom over the file cap for the multipart envelope (boundaries, part headers).
_MULTIPART_OVERHEAD = 1024 * 1024
# Cap for every body except the upload: JSON edits, markers and preferences are far below it.
MAX_BODY_BYTES = 1024 * 1024


def cookie_name(scope: Scope) -> str:
    """Session cookie name, keyed by port: cookies are shared across ports on one host,
    so two running instances must not overwrite each other's session."""
    server = scope.get("server")
    return f"sawt_session_{server[1]}" if server else "sawt_session"


class LocalGuard:
    """Pure ASGI middleware enforcing the Origin, token and upload-size rules."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        allowed_hosts: list[str],
        allowed_origins: list[str],
        token: Optional[str],
        max_upload_bytes: int,
    ) -> None:
        self.app = app
        self.allowed_hosts = {h.lower() for h in allowed_hosts}
        self.allowed_origins = {o.lower().rstrip("/") for o in allowed_origins}
        self.token = token
        self.max_body = max_upload_bytes + _MULTIPART_OVERHEAD

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        method = scope["method"]
        path = scope["path"]

        cross_site = headers.get("sec-fetch-site") == "cross-site"
        if cross_site or (
            method not in _SAFE_METHODS and not self._origin_ok(scope, headers.get("origin"))
        ):
            await _reject(send, 403, "ForbiddenOrigin", "cross-site request refused")
            return

        if self.token is not None:
            if path == SESSION_PATH:
                await self._start_session(scope, send)
                return
            if not self._token_ok(scope, headers):
                await _reject(send, 401, "Unauthorized", "missing or invalid launch token")
                return

        length = headers.get("content-length")
        if length is not None and not _DIGITS.fullmatch(length):
            await _reject(send, 400, "BadRequest", "invalid Content-Length")
            return

        if method == "POST" and path == UPLOAD_PATH:
            if length is None:
                await _reject(send, 411, "LengthRequired", "upload needs a Content-Length")
                return
            if int(length) > self.max_body:
                limit = CONFIG.extraction.max_upload_mb
                await _reject(
                    send, 413, "FileTooLargeError", f"Upload exceeds the {limit} MB limit."
                )
                return
        elif length is not None:
            if int(length) > MAX_BODY_BYTES:
                await _reject_too_large(send)
                return
        elif "transfer-encoding" in headers:
            body = await _read_capped(receive, MAX_BODY_BYTES)
            if body is None:
                await _reject_too_large(send)
                return
            receive = _replay(body, receive)

        await self.app(scope, receive, send)

    def _origin_ok(self, scope: Scope, origin: Optional[str]) -> bool:
        """The origin must be this service itself (local host name, same port) or listed
        in ``allowed_origins``. Another local port is a different origin."""
        # Browsers always send Origin on cross-origin writes; its absence means a
        # same-origin navigation or a non-browser client, which the token still covers.
        if origin is None:
            return True
        origin = origin.lower().rstrip("/")
        if origin in self.allowed_origins:
            return True
        parts = urlsplit(origin)
        server = scope.get("server")
        try:
            port = parts.port or 80
        except ValueError:
            return False
        return (
            parts.scheme == "http"
            and (parts.hostname or "") in self.allowed_hosts
            and server is not None
            and port == server[1]
        )

    def _token_ok(self, scope: Scope, headers: Headers) -> bool:
        presented = headers.get(TOKEN_HEADER)
        if presented is None:
            cookies = cookie_parser(headers.get("cookie", ""))
            presented = cookies.get(cookie_name(scope))
        return presented is not None and secrets.compare_digest(
            presented.encode(), self.token.encode()
        )

    async def _start_session(self, scope: Scope, send: Send) -> None:
        query = parse_qs(scope.get("query_string", b"").decode("latin-1"))
        presented = (query.get("token") or [""])[0]
        if not secrets.compare_digest(presented.encode(), self.token.encode()):
            await _reject(send, 401, "Unauthorized", "invalid launch token")
            return
        cookie = (
            f"{cookie_name(scope)}={self.token}; Path=/; HttpOnly; SameSite=Strict"
        )
        await send(
            {
                "type": "http.response.start",
                "status": 303,
                "headers": [
                    (b"location", b"/"),
                    (b"set-cookie", cookie.encode("latin-1")),
                    (b"cache-control", b"no-store"),
                    (b"content-length", b"0"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": b""})


async def _read_capped(receive: Receive, limit: int) -> Optional[bytes]:
    """Read the whole request body, or return ``None`` as soon as it exceeds ``limit``."""
    chunks: list[bytes] = []
    size = 0
    while True:
        message = await receive()
        if message["type"] != "http.request":
            break  # client disconnected; the app sees an empty body
        chunk = message.get("body", b"")
        size += len(chunk)
        if size > limit:
            return None
        chunks.append(chunk)
        if not message.get("more_body", False):
            break
    return b"".join(chunks)


def _replay(body: bytes, receive: Receive) -> Receive:
    """A ``receive`` that yields the buffered body once, then defers to the original."""
    sent = False

    async def replay() -> Message:
        nonlocal sent
        if not sent:
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return await receive()

    return replay


async def _reject_too_large(send: Send) -> None:
    await _reject(
        send,
        413,
        "RequestTooLargeError",
        f"The request body exceeds the {MAX_BODY_BYTES // (1024 * 1024)} MB limit.",
    )


async def _reject(send: Send, status: int, error: str, detail: str) -> None:
    """Answer with the service's ``{error, detail}`` envelope without calling the app."""
    body = json.dumps({"error": error, "detail": detail}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


def install_guards(
    app: FastAPI,
    allowed_hosts: list[str],
    allowed_origins: list[str],
    token: Optional[str],
) -> None:
    """Add the guards; the Host check is added last so it runs first."""
    app.add_middleware(
        LocalGuard,
        allowed_hosts=allowed_hosts,
        allowed_origins=allowed_origins,
        token=token,
        max_upload_bytes=CONFIG.extraction.max_upload_mb * 1024 * 1024,
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
