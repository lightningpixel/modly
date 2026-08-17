"""Local-API access control: loopback host, local Origin, optional bearer token.

Electron always sets MODLY_API_TOKEN. Headless `uvicorn` without the env var
stays usable for trusted-machine development, but browser requests from a
non-local Origin are still rejected.
"""
from __future__ import annotations

import hmac
import os
from urllib.parse import urlparse

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

TOKEN_HEADER = "x-modly-token"
TOKEN_ENV = "MODLY_API_TOKEN"
ALLOW_REMOTE_ENV = "MODLY_API_ALLOW_REMOTE"
PUBLIC_PATHS = {"/health"}


def api_token() -> str:
    return os.environ.get(TOKEN_ENV, "").strip()


def allow_remote() -> bool:
    return os.environ.get(ALLOW_REMOTE_ENV, "").strip().lower() in {"1", "true", "yes"}


def auth_mode() -> str:
    return "required" if api_token() else "off"


def _hostname_from_host(host: str) -> str:
    value = (host or "").strip()
    if value.startswith("["):
        end = value.find("]")
        if end != -1:
            return value[1:end].lower()
    return value.rsplit(":", 1)[0].lower()


def is_loopback_host(host: str) -> bool:
    hostname = _hostname_from_host(host)
    return hostname in {"127.0.0.1", "localhost", "::1"}


def is_local_origin(origin: str | None) -> bool:
    if origin is None or origin == "" or origin == "null":
        return True
    parsed = urlparse(origin)
    if parsed.scheme in {"file", "app"}:
        return True
    if not parsed.hostname:
        return origin.startswith("file://")
    return parsed.hostname.lower() in {"127.0.0.1", "localhost", "::1"}


def extract_bearer_token(authorization: str | None, header_token: str | None) -> str:
    if header_token and header_token.strip():
        return header_token.strip()
    if not authorization:
        return ""
    scheme, _, remainder = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return ""
    return remainder.strip()


def tokens_match(expected: str, provided: str) -> bool:
    if not expected or not provided:
        return False
    return hmac.compare_digest(expected.encode("utf-8"), provided.encode("utf-8"))


class LocalApiGuardMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        # Preflight has no Authorization header; CORSMiddleware answers OPTIONS.
        if path in PUBLIC_PATHS or request.method == "OPTIONS":
            return await call_next(request)

        if not allow_remote():
            host = request.headers.get("host", "")
            if host and not is_loopback_host(host):
                return JSONResponse({"detail": "Host is not a loopback address"}, status_code=403)

            origin = request.headers.get("origin")
            if origin and not is_local_origin(origin):
                return JSONResponse({"detail": "Origin is not allowed"}, status_code=403)

        expected = api_token()
        if expected:
            provided = extract_bearer_token(
                request.headers.get("authorization"),
                request.headers.get(TOKEN_HEADER),
            )
            if not tokens_match(expected, provided):
                return JSONResponse({"detail": "Missing or invalid API token"}, status_code=401)

        return await call_next(request)
