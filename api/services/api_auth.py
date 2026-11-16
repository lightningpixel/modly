"""
Locks the local API to the Modly app.

Electron starts the backend with ``MODLY_API_TOKEN`` (a per-launch secret) and
``MODLY_ALLOWED_ORIGINS`` (the renderer's origins). Every request must then
carry ``X-Modly-Token: <token>``, so a web page open in the user's browser can
no longer drive the API while Modly runs.

Without ``MODLY_API_TOKEN`` (a standalone ``uvicorn main:app`` run, modly-cli
``serve``, a Jetson box) the API stays open, as before, and says so once at
startup.
"""
import base64
import hashlib
import hmac
import json
import logging
import os

logger = logging.getLogger("modly.api_auth")

TOKEN_ENV = "MODLY_API_TOKEN"
ORIGINS_ENV = "MODLY_ALLOWED_ORIGINS"
TOKEN_HEADER = "X-Modly-Token"

_UNAUTHORIZED_BODY = json.dumps({"detail": "Missing or invalid Modly API token"}).encode("utf-8")

# Fetched by OrcaSlicer, an external app that cannot send the header: the route
# checks its own HMAC signature instead (see sign_slicer_source).
SLICER_PREFIX = "/export/slicer/"


def _read_token() -> str | None:
    return (os.environ.get(TOKEN_ENV) or "").strip() or None


# Read once at startup; tests patch this attribute.
API_TOKEN: str | None = _read_token()


def allowed_origins(token: str | None) -> list[str]:
    """CORS origins: the app's own (from env) when locked, anything when tokenless."""
    if not token:
        return ["*"]
    raw = os.environ.get(ORIGINS_ENV) or ""
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def auth_headers() -> dict[str, str]:
    """Headers for the backend's own calls back into the API."""
    return {TOKEN_HEADER: API_TOKEN} if API_TOKEN else {}


def token_matches(supplied: str | None, token: str) -> bool:
    if not supplied:
        return False
    return hmac.compare_digest(supplied.encode("utf-8"), token.encode("utf-8"))


def _is_exempt(method: str, path: str) -> bool:
    if method == "OPTIONS":
        return True
    if method in ("GET", "HEAD") and (path == "/health" or path.startswith(SLICER_PREFIX)):
        return True
    return False


class ApiTokenMiddleware:
    """Pure ASGI middleware: rejects requests without the right X-Modly-Token."""

    def __init__(self, app, token: str):
        self.app = app
        self.token = token

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)

        method = scope.get("method", "GET")
        if _is_exempt(method, scope.get("path", "")):
            return await self.app(scope, receive, send)

        supplied = None
        for name, value in scope.get("headers") or ():
            if name == b"x-modly-token":
                supplied = value.decode("latin-1")
                break
        if token_matches(supplied, self.token):
            return await self.app(scope, receive, send)

        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        await send({
            "type": "http.response.start",
            "status": 401,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(_UNAUTHORIZED_BODY)).encode("ascii")),
            ],
        })
        await send({"type": "http.response.body", "body": _UNAUTHORIZED_BODY})


def configure(app) -> None:
    """Install the token check and CORS on ``app`` from the startup env."""
    from fastapi.middleware.cors import CORSMiddleware

    token = API_TOKEN
    if token:
        # Added first so CORS wraps it: a 401 still carries CORS headers and the
        # renderer can read it.
        app.add_middleware(ApiTokenMiddleware, token=token)
    else:
        logger.warning(
            "API token disabled: %s is not set, so any local process or web page "
            "can call this API. The Modly app always sets it.", TOKEN_ENV,
        )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins(token),
        allow_methods=["*"],
        allow_headers=["*"],
        # drei's SplatLoader reads Content-Length to size its buffers; cross-origin
        # JS can only see it when the server explicitly exposes the header.
        expose_headers=["Content-Length"],
    )


# ---------------------------------------------------------------------------
# OrcaSlicer links
# ---------------------------------------------------------------------------

def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _slicer_signature(token: str, fmt: str, source_path: str) -> str:
    message = f"{fmt.lower()}\0{source_path}".encode("utf-8")
    return _b64(hmac.new(token.encode("utf-8"), message, hashlib.sha256).digest())


def sign_slicer_source(fmt: str, source_path: str) -> str:
    """The ``{token}`` path segment of a slicer URL for ``source_path``.

    ``<b64url(path)>.<b64url(hmac)>`` when the API is locked (``.`` is not in the
    url-safe base64 alphabet, so the split is unambiguous); just the path part
    when tokenless.
    """
    encoded = _b64(source_path.encode("utf-8"))
    if not API_TOKEN:
        return encoded
    return f"{encoded}.{_slicer_signature(API_TOKEN, fmt, source_path)}"


def split_slicer_token(segment: str) -> tuple[str, str | None]:
    """``(b64path, signature or None)`` from a slicer ``{token}`` segment."""
    encoded, dot, signature = segment.partition(".")
    return encoded, (signature if dot else None)


def slicer_signature_valid(fmt: str, source_path: str, signature: str | None) -> bool:
    """True when tokenless, else when ``signature`` signs ``fmt`` + ``source_path``."""
    if not API_TOKEN:
        return True
    if not signature:
        return False
    expected = _slicer_signature(API_TOKEN, fmt, source_path)
    return hmac.compare_digest(signature.encode("ascii", "replace"), expected.encode("ascii"))
