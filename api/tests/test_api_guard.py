import unittest
from unittest.mock import patch

try:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from services.api_guard import (
        LocalApiGuardMiddleware,
        extract_bearer_token,
        is_local_origin,
        is_loopback_host,
        tokens_match,
    )
    HAS_FASTAPI = True
except ImportError:  # pragma: no cover - system Python without api/requirements.txt
    HAS_FASTAPI = False
    FastAPI = TestClient = LocalApiGuardMiddleware = None  # type: ignore[misc, assignment]


def _app() -> FastAPI:
    app = FastAPI()
    app.add_middleware(LocalApiGuardMiddleware)

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/secret")
    def secret():
        return {"ok": True}

    return app


@unittest.skipUnless(HAS_FASTAPI, "fastapi is not installed in this Python")
class GuardHelperTests(unittest.TestCase):
    def test_loopback_hosts(self) -> None:
        self.assertTrue(is_loopback_host("127.0.0.1:8765"))
        self.assertTrue(is_loopback_host("localhost"))
        self.assertTrue(is_loopback_host("[::1]:8765"))
        self.assertFalse(is_loopback_host("evil.example:8765"))
        self.assertFalse(is_loopback_host("192.168.1.10:8000"))

    def test_local_origins(self) -> None:
        self.assertTrue(is_local_origin(None))
        self.assertTrue(is_local_origin("null"))
        self.assertTrue(is_local_origin("http://127.0.0.1:5173"))
        self.assertTrue(is_local_origin("http://localhost:5173"))
        self.assertTrue(is_local_origin("file://"))
        self.assertFalse(is_local_origin("https://evil.example"))

    def test_bearer_extract_and_compare(self) -> None:
        self.assertEqual(extract_bearer_token("Bearer abc", None), "abc")
        self.assertEqual(extract_bearer_token(None, "xyz"), "xyz")
        self.assertTrue(tokens_match("secret", "secret"))
        self.assertFalse(tokens_match("secret", "other"))
        self.assertFalse(tokens_match("", ""))


@unittest.skipUnless(HAS_FASTAPI, "fastapi is not installed in this Python")
class GuardMiddlewareTests(unittest.TestCase):
    def setUp(self) -> None:
        self.env = patch.dict("os.environ", {"MODLY_API_TOKEN": "", "MODLY_API_ALLOW_REMOTE": ""}, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)

    def test_health_is_public(self) -> None:
        client = TestClient(_app(), base_url="http://127.0.0.1")
        self.assertEqual(client.get("/health").status_code, 200)

    def test_rejects_foreign_origin(self) -> None:
        client = TestClient(_app(), base_url="http://127.0.0.1")
        res = client.get("/secret", headers={"Origin": "https://evil.example"})
        self.assertEqual(res.status_code, 403)

    def test_rejects_non_loopback_host(self) -> None:
        client = TestClient(_app(), base_url="http://127.0.0.1")
        res = client.get("/secret", headers={"Host": "evil.example"})
        self.assertEqual(res.status_code, 403)

    def test_token_required_when_configured(self) -> None:
        with patch.dict("os.environ", {"MODLY_API_TOKEN": "s3cret"}, clear=False):
            client = TestClient(_app(), base_url="http://127.0.0.1")
            self.assertEqual(client.get("/secret").status_code, 401)
            ok = client.get("/secret", headers={"Authorization": "Bearer s3cret"})
            self.assertEqual(ok.status_code, 200)
            alt = client.get("/secret", headers={"X-Modly-Token": "s3cret"})
            self.assertEqual(alt.status_code, 200)

    def test_allow_remote_skips_host_origin_but_not_token(self) -> None:
        env = {"MODLY_API_TOKEN": "s3cret", "MODLY_API_ALLOW_REMOTE": "1"}
        with patch.dict("os.environ", env, clear=False):
            client = TestClient(_app(), base_url="http://127.0.0.1")
            denied = client.get("/secret", headers={"Host": "jetson.local", "Origin": "http://192.168.1.10"})
            self.assertEqual(denied.status_code, 401)
            ok = client.get(
                "/secret",
                headers={"Host": "jetson.local", "Authorization": "Bearer s3cret"},
            )
            self.assertEqual(ok.status_code, 200)


if __name__ == "__main__":
    unittest.main()
