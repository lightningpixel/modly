import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx
from fastapi import FastAPI

from services import api_auth

TOKEN = "0123456789abcdef" * 4


def _app(token: str | None, origins: str = "") -> FastAPI:
    """A tiny app wired exactly like main.py, with routes standing in for the real ones."""
    app = FastAPI()
    with mock.patch.object(api_auth, "API_TOKEN", token), \
            mock.patch.dict(os.environ, {api_auth.ORIGINS_ENV: origins}):
        api_auth.configure(app)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/model/all")
    def models():
        return []

    @app.post("/model/switch")
    def switch():
        return {"ok": True}

    @app.get("/export/slicer/{fmt}/{token}/{filename}")
    def slicer(fmt: str, token: str, filename: str):
        return {"served": True}

    return app


def _request(app: FastAPI, method: str, path: str, headers: dict | None = None) -> httpx.Response:
    async def go():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8765") as client:
            return await client.request(method, path, headers=headers or {})
    return asyncio.run(go())


class TokenMiddlewareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.app = _app(TOKEN, "http://localhost:5173,null")

    def test_missing_token_is_401_with_json_detail(self) -> None:
        r = _request(self.app, "GET", "/model/all")
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.json(), {"detail": "Missing or invalid Modly API token"})

    def test_wrong_token_is_401(self) -> None:
        r = _request(self.app, "POST", "/model/switch", {"X-Modly-Token": "f" * 64})
        self.assertEqual(r.status_code, 401)

    def test_right_token_passes(self) -> None:
        self.assertEqual(_request(self.app, "GET", "/model/all", {"X-Modly-Token": TOKEN}).status_code, 200)
        self.assertEqual(_request(self.app, "POST", "/model/switch", {"x-modly-token": TOKEN}).status_code, 200)

    def test_health_is_exempt(self) -> None:
        r = _request(self.app, "GET", "/health")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), {"status": "ok"})

    def test_options_is_exempt(self) -> None:
        r = _request(self.app, "OPTIONS", "/model/all")
        self.assertNotEqual(r.status_code, 401)

    def test_slicer_route_is_left_to_its_own_signature(self) -> None:
        r = _request(self.app, "GET", "/export/slicer/stl/abc.def/model.stl")
        self.assertEqual(r.status_code, 200)

    def test_similar_paths_are_not_exempt(self) -> None:
        self.assertEqual(_request(self.app, "GET", "/healthz").status_code, 401)
        self.assertEqual(_request(self.app, "GET", "/export/slicer-link?path=a.glb").status_code, 401)

    def test_401_still_carries_cors_headers_for_the_app_origin(self) -> None:
        r = _request(self.app, "GET", "/model/all", {"Origin": "http://localhost:5173"})
        self.assertEqual(r.status_code, 401)
        self.assertEqual(r.headers.get("access-control-allow-origin"), "http://localhost:5173")


class CorsTests(unittest.TestCase):
    def _preflight(self, app: FastAPI, origin: str) -> httpx.Response:
        return _request(app, "OPTIONS", "/model/all", {
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "x-modly-token,content-type",
        })

    def test_locked_mode_allows_only_the_configured_origins(self) -> None:
        app = _app(TOKEN, " http://localhost:5173 , ,null,")
        ok = self._preflight(app, "http://localhost:5173")
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.headers["access-control-allow-origin"], "http://localhost:5173")
        self.assertIn("x-modly-token", ok.headers["access-control-allow-headers"].lower())
        self.assertEqual(self._preflight(app, "null").status_code, 200)
        self.assertEqual(self._preflight(app, "https://evil.example").status_code, 400)

    def test_locked_mode_exposes_content_length(self) -> None:
        r = _request(_app(TOKEN, "null"), "GET", "/model/all", {"Origin": "null", "X-Modly-Token": TOKEN})
        self.assertIn("content-length", r.headers.get("access-control-expose-headers", "").lower())

    def test_allowed_origins_parsing(self) -> None:
        with mock.patch.dict(os.environ, {api_auth.ORIGINS_ENV: "http://localhost:5173,file://,null, ,"}):
            self.assertEqual(api_auth.allowed_origins(TOKEN), ["http://localhost:5173", "file://", "null"])
            self.assertEqual(api_auth.allowed_origins(None), ["*"])


class TokenlessModeTests(unittest.TestCase):
    def test_everything_is_allowed_and_cors_is_open(self) -> None:
        app = _app(None)
        self.assertEqual(_request(app, "GET", "/model/all").status_code, 200)
        self.assertEqual(_request(app, "POST", "/model/switch", {"X-Modly-Token": "junk"}).status_code, 200)
        r = _request(app, "GET", "/model/all", {"Origin": "https://anything.example"})
        self.assertEqual(r.headers.get("access-control-allow-origin"), "*")

    def test_warns_once_at_startup(self) -> None:
        with self.assertLogs("modly.api_auth", level="WARNING") as logs:
            _app(None)
        self.assertEqual(len(logs.records), 1)
        self.assertIn("API token disabled", logs.output[0])

    def test_token_is_read_from_env_and_stripped(self) -> None:
        with mock.patch.dict(os.environ, {api_auth.TOKEN_ENV: f"  {TOKEN}\n"}):
            self.assertEqual(api_auth._read_token(), TOKEN)
        with mock.patch.dict(os.environ, {api_auth.TOKEN_ENV: "  "}):
            self.assertIsNone(api_auth._read_token())

    def test_auth_headers(self) -> None:
        with mock.patch.object(api_auth, "API_TOKEN", TOKEN):
            self.assertEqual(api_auth.auth_headers(), {"X-Modly-Token": TOKEN})
        with mock.patch.object(api_auth, "API_TOKEN", None):
            self.assertEqual(api_auth.auth_headers(), {})


class AgentClientTests(unittest.TestCase):
    def test_tool_calls_back_into_the_api_carry_the_token(self) -> None:
        import routers.agent as agent

        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=[])

        real = httpx.AsyncClient

        def client(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            return real(*args, **kwargs)

        with mock.patch.object(api_auth, "API_TOKEN", TOKEN), \
                mock.patch.object(agent.httpx, "AsyncClient", client):
            asyncio.run(agent.execute_tool("list_models", {}, {}))
        self.assertTrue(seen)
        self.assertEqual(seen[0].headers.get("x-modly-token"), TOKEN)


def _load_mcp_server():
    """Import mcp_server with the `mcp` SDK stubbed: only its HTTP side is under
    test, and the installed SDK version may not match the decorators it uses."""
    import importlib
    import sys
    import types

    class _Server:
        def __init__(self, *_args, **_kwargs):
            pass

        def __getattr__(self, _name):
            return lambda *a, **k: (lambda fn: fn)

    class _TextContent:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    stubs = {
        "mcp": types.ModuleType("mcp"),
        "mcp.server": types.ModuleType("mcp.server"),
        "mcp.server.stdio": types.ModuleType("mcp.server.stdio"),
        "mcp.types": types.ModuleType("mcp.types"),
    }
    stubs["mcp.server"].Server = _Server
    stubs["mcp.server.stdio"].stdio_server = None
    stubs["mcp.types"].Tool = dict
    stubs["mcp.types"].TextContent = _TextContent
    with mock.patch.dict(sys.modules, stubs):
        sys.modules.pop("mcp_server", None)
        module = importlib.import_module("mcp_server")
        sys.modules.pop("mcp_server", None)
    return module


try:
    mcp_server = _load_mcp_server()
    HAVE_MCP = True
except Exception:  # noqa: BLE001
    HAVE_MCP = False


@unittest.skipUnless(HAVE_MCP, "mcp_server could not be imported")
class McpServerTokenTests(unittest.TestCase):
    def test_reads_the_token_file_next_to_api_port(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            (Path(td) / "api-token").write_text(TOKEN + "\n")
            with mock.patch.object(mcp_server, "_modly_user_data", return_value=Path(td)), \
                    mock.patch.dict(os.environ, {"MODLY_API_TOKEN": "env"}):
                self.assertEqual(mcp_server.resolve_api_token(), TOKEN)
                self.assertEqual(mcp_server.api_headers(), {"X-Modly-Token": TOKEN})

    def test_falls_back_to_env_then_no_header(self) -> None:
        with tempfile.TemporaryDirectory() as td, \
                mock.patch.object(mcp_server, "_modly_user_data", return_value=Path(td)):
            with mock.patch.dict(os.environ, {"MODLY_API_TOKEN": "env"}):
                self.assertEqual(mcp_server.resolve_api_token(), "env")
            with mock.patch.dict(os.environ, {"MODLY_API_TOKEN": ""}):
                self.assertEqual(mcp_server.api_headers(), {})

    def test_tool_calls_send_the_header(self) -> None:
        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json=[])

        real = httpx.AsyncClient

        def client(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            return real(*args, **kwargs)

        with mock.patch.object(mcp_server, "resolve_api_token", return_value=TOKEN), \
                mock.patch.object(mcp_server.httpx, "AsyncClient", client):
            asyncio.run(mcp_server.call_tool("modly_list_models", {}))
        self.assertEqual(seen[0].headers.get("x-modly-token"), TOKEN)


if __name__ == "__main__":
    unittest.main()
