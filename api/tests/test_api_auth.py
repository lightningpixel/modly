"""
The API's per-launch token.

Loopback keeps other machines out; it does not keep the user's own browser out.
Any page the user has open can POST to 127.0.0.1:8765, and the server answers
with Access-Control-Allow-Origin: * - so the page reads the answer too. These
tests pin the middleware that makes the token, not the network, the boundary.
"""
import importlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def _client_with_token(token: str):
    """A TestClient over an app instance whose middleware saw `token` at import."""
    import os
    from fastapi.testclient import TestClient

    previous = os.environ.get("MODLY_API_TOKEN")
    os.environ["MODLY_API_TOKEN"] = token
    try:
        main = importlib.reload(importlib.import_module("main"))
        return TestClient(main.app), main
    finally:
        if previous is None:
            os.environ.pop("MODLY_API_TOKEN", None)
        else:
            os.environ["MODLY_API_TOKEN"] = previous


class TokenRequiredTests(unittest.TestCase):
    TOKEN = "0123456789abcdef"

    @classmethod
    def setUpClass(cls) -> None:
        cls.client, cls.main = _client_with_token(cls.TOKEN)

    @classmethod
    def tearDownClass(cls) -> None:
        # Leave the module as the rest of the suite expects it: unauthenticated.
        importlib.reload(cls.main)

    def _headers(self) -> dict:
        return {"x-modly-token": self.TOKEN}

    def test_a_request_without_the_token_is_refused(self):
        r = self.client.get("/settings/paths")
        self.assertEqual(r.status_code, 401)

    def test_a_request_with_a_wrong_token_is_refused(self):
        r = self.client.get("/settings/paths", headers={"x-modly-token": "not-it"})
        self.assertEqual(r.status_code, 401)

    def test_the_state_changing_endpoints_are_covered_too(self):
        """`POST /settings/paths` repoints the workspace, which is how an
        attacker would get file serving to hand over any directory."""
        r = self.client.post("/settings/paths", json={"workspace_dir": "C:\\"})
        self.assertEqual(r.status_code, 401)

    def test_a_request_with_the_token_goes_through(self):
        r = self.client.get("/settings/paths", headers=self._headers())
        self.assertEqual(r.status_code, 200)
        self.assertIn("workspace_dir", r.json())

    def test_the_health_probe_stays_open(self):
        """python-bridge.ts polls /health to know when the backend is up, before
        anything could have handed it a token."""
        r = self.client.get("/health")
        self.assertEqual(r.status_code, 200)

    def test_a_preflight_is_still_answered(self):
        """A browser preflight carries no custom header by definition. Answering
        it grants nothing: the request that follows still needs the token."""
        r = self.client.options("/settings/paths", headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        })
        self.assertEqual(r.status_code, 200)
        r = self.client.post("/settings/paths", json={"workspace_dir": "C:\\"},
                             headers={"Origin": "https://evil.example"})
        self.assertEqual(r.status_code, 401)


class TokenAbsentTests(unittest.TestCase):
    """A backend started by hand - tests, `uvicorn main:app`, the eval harness
    against a dev server - has no token and stays open, exactly as before."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.client, cls.main = _client_with_token("")

    def test_requests_go_through_without_a_token(self):
        r = self.client.get("/settings/paths")
        self.assertEqual(r.status_code, 200)


class LocalHeadersTests(unittest.TestCase):
    """What the MCP server, the CLI and the eval harness send."""

    def setUp(self) -> None:
        self.api_token = importlib.import_module("services.api_token")

    def test_the_environment_wins_over_the_file(self):
        import os
        previous = os.environ.get("MODLY_API_TOKEN")
        os.environ["MODLY_API_TOKEN"] = "  from-env  "
        try:
            self.assertEqual(self.api_token.local_headers(), {"x-modly-token": "from-env"})
        finally:
            if previous is None:
                os.environ.pop("MODLY_API_TOKEN", None)
            else:
                os.environ["MODLY_API_TOKEN"] = previous

    def test_no_token_anywhere_sends_no_header(self):
        import os
        previous = os.environ.get("MODLY_API_TOKEN")
        os.environ.pop("MODLY_API_TOKEN", None)
        original_file = self.api_token.TOKEN_FILE
        self.api_token.TOKEN_FILE = Path("does-not-exist-modly-token")
        try:
            self.assertEqual(self.api_token.local_headers(), {})
        finally:
            self.api_token.TOKEN_FILE = original_file
            if previous is not None:
                os.environ["MODLY_API_TOKEN"] = previous


if __name__ == "__main__":
    unittest.main()
