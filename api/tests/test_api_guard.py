import asyncio
import os
import re
import unittest

from services import api_guard
from services.api_guard import ApiGuardMiddleware, GuardConfig, host_allowed, is_allowed

HOST = "127.0.0.1:8765"
SECRET = "s3cret"


def headers(**values: str) -> dict[str, str]:
    """Request headers; ``sec_fetch_site=`` becomes ``sec-fetch-site``."""
    out = {"host": HOST}
    out.update({name.replace("_", "-"): value for name, value in values.items()})
    return out


class RuleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = GuardConfig(app_secret=SECRET, app_origins=["http://localhost:5173"])

    def allowed(self, method: str = "GET", config: GuardConfig | None = None, **values: str) -> bool:
        return is_allowed(method, headers(**values), config or self.config)

    def test_callers_that_are_not_web_pages_pass_without_a_token(self) -> None:
        # curl, scripts, modly-cli, MCP, OrcaSlicer: no Origin, no Sec-Fetch-Site.
        self.assertTrue(self.allowed())
        self.assertTrue(self.allowed("POST"))
        # A URL typed in the browser's address bar.
        self.assertTrue(self.allowed(sec_fetch_site="none"))

    def test_web_pages_are_refused(self) -> None:
        self.assertFalse(self.allowed("POST", origin="https://evil.example", sec_fetch_site="cross-site"))
        self.assertFalse(self.allowed(origin="https://evil.example"))
        # <img src> / <script src> / a link from another site: no Origin, but cross-site.
        self.assertFalse(self.allowed(sec_fetch_site="cross-site"))
        self.assertFalse(self.allowed(sec_fetch_site="same-site"))

    def test_null_origin_needs_the_app_secret(self) -> None:
        # A sandboxed iframe on any site sends Origin: null, like the packaged app.
        self.assertFalse(self.allowed("POST", origin="null", sec_fetch_site="cross-site"))
        self.assertFalse(self.allowed("POST", origin="null", x_modly_app="wrong"))
        self.assertTrue(self.allowed("POST", origin="null", sec_fetch_site="cross-site", x_modly_app=SECRET))

    def test_no_secret_configured_never_matches(self) -> None:
        config = GuardConfig()
        self.assertFalse(self.allowed("POST", config=config, origin="null", x_modly_app=""))

    def test_the_dev_renderer_and_the_api_own_pages_pass(self) -> None:
        self.assertTrue(self.allowed("POST", origin="http://localhost:5173"))
        self.assertTrue(self.allowed("POST", origin=f"http://{HOST}", sec_fetch_site="same-origin"))

    def test_modly_origins_with_wildcards(self) -> None:
        config = GuardConfig.from_env({"MODLY_ORIGINS": " http://localhost:* , chrome-extension://* ,https://app.example.com/"})
        self.assertTrue(self.allowed("POST", config=config, origin="http://localhost:3000"))
        self.assertTrue(self.allowed("POST", config=config, origin="chrome-extension://abcdef"))
        self.assertTrue(self.allowed("POST", config=config, origin="https://APP.example.com"))
        self.assertFalse(self.allowed("POST", config=config, origin="https://app.example.com.evil.net"))
        self.assertFalse(self.allowed("POST", config=config, origin="http://127.0.0.1:3000"))
        self.assertFalse(self.allowed("POST", config=config, origin="null"))

    def test_star_opens_the_api_to_every_page(self) -> None:
        config = GuardConfig.from_env({"MODLY_ORIGINS": "*"})
        self.assertTrue(self.allowed("POST", config=config, origin="https://anything.example"))

    def test_preflight_passes_the_gate(self) -> None:
        self.assertTrue(self.allowed("OPTIONS", origin="https://evil.example", sec_fetch_site="cross-site"))


class HostTests(unittest.TestCase):
    def test_loopback_and_ip_addresses(self) -> None:
        config = GuardConfig()
        for host in ("127.0.0.1:8765", "localhost:8765", "LOCALHOST", "[::1]:8765", "::1", "192.168.1.20:8000", "0.0.0.0"):
            self.assertTrue(host_allowed(host, config), host)
        self.assertTrue(host_allowed(None, config))

    def test_dns_rebinding_names_are_refused(self) -> None:
        config = GuardConfig()
        self.assertFalse(host_allowed("evil.example:8765", config))
        self.assertFalse(host_allowed("localhost.evil.example", config))
        # Even with no Origin at all: the rebound page's fetch is same-origin.
        self.assertFalse(is_allowed("GET", {"host": "evil.example:8765"}, config))

    def test_modly_hosts_adds_names(self) -> None:
        config = GuardConfig.from_env({"MODLY_HOSTS": "jetson.local,*.lan"})
        self.assertTrue(host_allowed("jetson.local:8000", config))
        self.assertTrue(host_allowed("box.lan", config))
        self.assertFalse(host_allowed("jetson.local.evil.example", config))


class CorsTests(unittest.TestCase):
    def test_cors_lets_the_app_pages_and_modly_origins_read_responses(self) -> None:
        config = GuardConfig.from_env({"MODLY_APP_ORIGINS": "http://localhost:5173", "MODLY_ORIGINS": "http://localhost:*"})
        regex = re.compile(config.cors_origin_regex())
        for origin in ("null", "file://", "http://localhost:5173", "http://LOCALHOST:3000"):
            self.assertTrue(regex.fullmatch(origin), origin)
        self.assertFalse(regex.fullmatch("https://evil.example"))


class _App:
    def __init__(self) -> None:
        self.calls = 0

    async def __call__(self, scope, receive, send) -> None:
        self.calls += 1
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})


def run(middleware, scope) -> list[dict]:
    sent: list[dict] = []

    async def receive():
        return {"type": "http.request", "body": b""}

    async def send(message):
        sent.append(message)

    asyncio.run(middleware(scope, receive, send))
    return sent


def http_scope(method: str = "GET", **values: str) -> dict:
    return {
        "type": "http",
        "method": method,
        "path": "/model/delete",
        "headers": [(k.encode("latin-1"), v.encode("latin-1")) for k, v in headers(**values).items()],
    }


class MiddlewareTests(unittest.TestCase):
    def test_refuses_a_web_page_with_403_and_never_runs_the_route(self) -> None:
        app = _App()
        sent = run(ApiGuardMiddleware(app, GuardConfig()), http_scope("POST", origin="https://evil.example"))
        self.assertEqual(app.calls, 0)
        self.assertEqual(sent[0]["status"], 403)
        self.assertIn(b"MODLY_ORIGINS", sent[1]["body"])

    def test_passes_a_script(self) -> None:
        app = _App()
        sent = run(ApiGuardMiddleware(app, GuardConfig()), http_scope("POST"))
        self.assertEqual(app.calls, 1)
        self.assertEqual(sent[0]["status"], 200)

    def test_closes_a_refused_websocket(self) -> None:
        app = _App()
        scope = {**http_scope(origin="https://evil.example"), "type": "websocket"}
        sent = run(ApiGuardMiddleware(app, GuardConfig()), scope)
        self.assertEqual(app.calls, 0)
        self.assertEqual(sent, [{"type": "websocket.close", "code": 1008}])

    def test_lifespan_is_not_checked(self) -> None:
        app = _App()
        run(ApiGuardMiddleware(app, GuardConfig()), {"type": "lifespan"})
        self.assertEqual(app.calls, 1)


class ConfigureTests(unittest.TestCase):
    def test_takes_the_secret_out_of_the_environment(self) -> None:
        from fastapi import FastAPI

        previous = os.environ.get(api_guard.APP_SECRET_ENV)
        os.environ[api_guard.APP_SECRET_ENV] = SECRET
        try:
            config = api_guard.configure(FastAPI())
            self.assertEqual(config.app_secret, SECRET)
            # Extensions and other subprocesses inherit os.environ.
            self.assertNotIn(api_guard.APP_SECRET_ENV, os.environ)
        finally:
            if previous is None:
                os.environ.pop(api_guard.APP_SECRET_ENV, None)
            else:
                os.environ[api_guard.APP_SECRET_ENV] = previous


if __name__ == "__main__":
    unittest.main()
