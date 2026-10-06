"""Request guards for the local API.

The service listens on localhost, so any web page the user visits can try to reach it.
``install_guards`` closes the two ways in:

* **DNS rebinding** -- ``TrustedHostMiddleware`` rejects any ``Host`` header that is not a
  local name, so a hostile domain re-pointed at ``127.0.0.1`` gets a 400.
* **Cross-site requests** -- ``LocalGuard`` rejects state-changing requests whose
  ``Origin`` is not local, requires the per-launch token when one is configured, and
  refuses oversized uploads from ``Content-Length`` before Starlette spools the body.

The token is presented as the ``X-Sawt-Token`` header or as an HttpOnly, SameSite=Strict
session cookie. The desktop window gets the cookie by first loading
``/_session?token=<token>``, which sets it and redirects to ``/``; from then on fetches,
``<audio>`` sources and download links all carry it automatically.
"""

from __future__ import annotations

import json
import secrets
from typing import Optional
from urllib.parse import parse_qs, urlsplit

from fastapi import FastAPI
from starlette.datastructures import Headers
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import cookie_parser
from starlette.types import ASGIApp, Receive, Scope, Send

from ..config import CONFIG

TOKEN_HEADER = "x-sawt-token"
SESSION_PATH = "/_session"
UPLOAD_PATH = "/projects/upload"
_SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
# Headroom over the file cap for the multipart envelope (boundaries, part headers).
_MULTIPART_OVERHEAD = 1024 * 1024


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
        token: Optional[str],
        max_upload_bytes: int,
    ) -> None:
        self.app = app
        self.allowed_hosts = {h.lower() for h in allowed_hosts}
        self.token = token
        self.max_body = max_upload_bytes + _MULTIPART_OVERHEAD

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = Headers(scope=scope)
        method = scope["method"]
        path = scope["path"]

        if method not in _SAFE_METHODS and not self._origin_ok(headers.get("origin")):
            await _reject(send, 403, "ForbiddenOrigin", "cross-site request refused")
            return

        if self.token is not None:
            if path == SESSION_PATH:
                await self._start_session(scope, send)
                return
            if not self._token_ok(scope, headers):
                await _reject(send, 401, "Unauthorized", "missing or invalid launch token")
                return

        if method == "POST" and path == UPLOAD_PATH:
            length = headers.get("content-length")
            if length is None or not length.isdigit():
                await _reject(send, 411, "LengthRequired", "upload needs a Content-Length")
                return
            if int(length) > self.max_body:
                limit = CONFIG.extraction.max_upload_mb
                await _reject(
                    send, 413, "FileTooLargeError", f"Upload exceeds the {limit} MB limit."
                )
                return

        await self.app(scope, receive, send)

    def _origin_ok(self, origin: Optional[str]) -> bool:
        # Browsers always send Origin on cross-origin writes; its absence means a
        # same-origin navigation or a non-browser client, which the token still covers.
        if origin is None:
            return True
        parts = urlsplit(origin)
        return parts.scheme == "http" and (parts.hostname or "") in self.allowed_hosts

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


def install_guards(app: FastAPI, allowed_hosts: list[str], token: Optional[str]) -> None:
    """Add the guards; the Host check is added last so it runs first."""
    app.add_middleware(
        LocalGuard,
        allowed_hosts=allowed_hosts,
        token=token,
        max_upload_bytes=CONFIG.extraction.max_upload_mb * 1024 * 1024,
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)
