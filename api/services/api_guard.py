"""
Keeps web pages off the local API, the way Ollama does.

The backend listens on 127.0.0.1, which every web page in the user's browser can
reach too. Browsers say where a request comes from (``Origin``,
``Sec-Fetch-Site``); other callers (scripts, curl, modly-cli, the MCP server,
OrcaSlicer, extensions) send neither. So:

- A request from a web page is refused unless its origin is allowed:
  the app's own pages, the origins in ``MODLY_ORIGINS`` (comma-separated,
  ``*`` wildcards, e.g. ``http://localhost:*,chrome-extension://*``), or the
  API's own origin (its /docs page).
- Any other request passes, with no token.
- The ``Host`` must be ``localhost``, an IP address, or a name in
  ``MODLY_HOSTS``: a web page that points its own domain at 127.0.0.1
  (DNS rebinding) still sends that domain as the Host.

The packaged app's pages are files, so their requests carry ``Origin: null``,
which any site can send too (from a sandboxed iframe). Electron therefore adds
``X-Modly-App: <secret>`` to its window's requests, with a secret made at each
launch and handed to the backend through ``MODLY_APP_SECRET`` only.
"""
from __future__ import annotations

import hmac
import ipaddress
import json
import logging
import os
import re
from dataclasses import dataclass, field

logger = logging.getLogger("modly.api_guard")

ORIGINS_ENV = "MODLY_ORIGINS"
HOSTS_ENV = "MODLY_HOSTS"
APP_SECRET_ENV = "MODLY_APP_SECRET"
APP_ORIGINS_ENV = "MODLY_APP_ORIGINS"
APP_HEADER = "x-modly-app"

# Origins the app's own pages send: a packaged build loads files, which send
# "null" (or "file://"); the dev renderer's origin comes in MODLY_APP_ORIGINS.
# Allowed by CORS only: a request from them still needs the app header.
FILE_ORIGINS = ("null", "file://")

# Sec-Fetch-Site values that mean another site made the request.
_CROSS_SITE = ("cross-site", "same-site")

_FORBIDDEN_BODY = json.dumps({
    "detail": "Requests from web pages are not allowed. Add the page's origin to MODLY_ORIGINS to allow it.",
}).encode("utf-8")


def _split(raw: str | None) -> list[str]:
    return [item.strip() for item in (raw or "").split(",") if item.strip()]


def _trim(origin: str) -> str:
    """``origin`` without a trailing slash, keeping the one of ``file://``."""
    return origin[:-1] if origin.endswith("/") and not origin.endswith("://") else origin


def _pattern(patterns: list[str]) -> re.Pattern[str] | None:
    """One case-insensitive regex for ``*``-wildcard patterns, or None when empty."""
    if not patterns:
        return None
    parts = ["".join(".*" if ch == "*" else re.escape(ch) for ch in p) for p in map(_trim, patterns)]
    return re.compile("(?:" + "|".join(parts) + ")", re.IGNORECASE)


@dataclass(frozen=True)
class GuardConfig:
    """What the guard allows, read from the environment at startup."""

    origins: list[str] = field(default_factory=list)
    hosts: list[str] = field(default_factory=list)
    app_origins: list[str] = field(default_factory=list)
    app_secret: str | None = None

    @classmethod
    def from_env(cls, env: os._Environ[str] | dict[str, str] | None = None) -> "GuardConfig":
        env = os.environ if env is None else env
        return cls(
            origins=_split(env.get(ORIGINS_ENV)),
            hosts=_split(env.get(HOSTS_ENV)),
            app_origins=_split(env.get(APP_ORIGINS_ENV)),
            app_secret=(env.get(APP_SECRET_ENV) or "").strip() or None,
        )

    def cors_origin_regex(self) -> str:
        """Origins CORS lets read responses: the app's pages and MODLY_ORIGINS."""
        pattern = _pattern([*FILE_ORIGINS, *self.app_origins, *self.origins])
        assert pattern is not None
        # Starlette compiles the string itself: carry the case-insensitive flag inline.
        return "(?i)" + pattern.pattern


def _host_name(host: str) -> str:
    """The name of a Host header value, without its port or IPv6 brackets."""
    host = host.strip().lower()
    if host.startswith("["):
        return host[1:].split("]", 1)[0]
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def host_allowed(host: str | None, config: GuardConfig) -> bool:
    if not host:
        return True  # HTTP/1.0 tools; every browser sends a Host
    name = _host_name(host)
    if name == "localhost":
        return True
    try:
        ipaddress.ip_address(name)
        return True
    except ValueError:
        pass
    pattern = _pattern(config.hosts)
    return bool(pattern and pattern.fullmatch(name))


def origin_allowed(origin: str, config: GuardConfig) -> bool:
    """Whether a web page at ``origin`` may call the API (MODLY_ORIGINS, or the dev renderer)."""
    pattern = _pattern([*config.app_origins, *config.origins])
    return bool(pattern and pattern.fullmatch(_trim(origin)))


def _secret_matches(supplied: str | None, secret: str | None) -> bool:
    if not supplied or not secret:
        return False
    return hmac.compare_digest(supplied.encode("utf-8"), secret.encode("utf-8"))


def is_allowed(method: str, headers: dict[str, str], config: GuardConfig) -> bool:
    """The guard's whole rule. ``headers`` has lowercase names."""
    host = headers.get("host")
    if not host_allowed(host, config):
        return False
    if method == "OPTIONS":
        return True  # CORS preflight: answered by CORS, runs nothing
    if _secret_matches(headers.get(APP_HEADER), config.app_secret):
        return True

    origin = headers.get("origin")
    site = (headers.get("sec-fetch-site") or "").lower()
    if origin is None and site not in _CROSS_SITE:
        return True  # not a web page: scripts, CLI, OrcaSlicer, a URL typed in the browser
    if origin is None:
        return False  # another site's <img>, <script> or link
    if host and _trim(origin).lower() == f"http://{host.strip().lower()}":
        return True  # the API's own pages (/docs)
    return origin_allowed(origin, config)


class ApiGuardMiddleware:
    """Pure ASGI middleware applying ``is_allowed``; 403 otherwise."""

    def __init__(self, app, config: GuardConfig):
        self.app = app
        self.config = config

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)

        headers = {name.decode("latin-1").lower(): value.decode("latin-1") for name, value in scope.get("headers") or ()}
        method = scope.get("method", "GET") if scope["type"] == "http" else "GET"
        if is_allowed(method, headers, self.config):
            return await self.app(scope, receive, send)

        logger.warning(
            "Refused %s %s from origin %s (host %s)",
            method, scope.get("path", ""), headers.get("origin") or headers.get("sec-fetch-site") or "-", headers.get("host") or "-",
        )
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        await send({
            "type": "http.response.start",
            "status": 403,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(_FORBIDDEN_BODY)).encode("ascii")),
            ],
        })
        await send({"type": "http.response.body", "body": _FORBIDDEN_BODY})


def configure(app, config: GuardConfig | None = None) -> GuardConfig:
    """Install the guard and CORS on ``app`` from the startup environment."""
    from fastapi.middleware.cors import CORSMiddleware

    config = config or GuardConfig.from_env()
    # Extensions and other subprocesses inherit the backend's env: the secret is
    # the app window's alone.
    os.environ.pop(APP_SECRET_ENV, None)

    # Added first so CORS wraps it: a 403 still carries CORS headers and the
    # page can read why.
    app.add_middleware(ApiGuardMiddleware, config=config)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=config.cors_origin_regex(),
        allow_methods=["*"],
        allow_headers=["*"],
        # drei's SplatLoader reads Content-Length to size its buffers; cross-origin
        # JS can only see it when the server explicitly exposes the header.
        expose_headers=["Content-Length"],
    )
    if config.origins:
        logger.info("Web pages allowed by %s: %s", ORIGINS_ENV, ", ".join(config.origins))
    return config
