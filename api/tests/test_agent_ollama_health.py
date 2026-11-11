import asyncio
import unittest
from unittest import mock

import httpx

import routers.agent as agent
from services import ollama_health


class _MockClientFactory:
    """Real AsyncClients wired to a MockTransport, so the health check talks to a
    fake Ollama instead of the network."""

    def __init__(self, handler) -> None:
        self._handler = handler
        self._real = httpx.AsyncClient
        self.kwargs: list[dict] = []

    def __call__(self, *args, **kwargs):
        self.kwargs.append(dict(kwargs))
        kwargs["transport"] = httpx.MockTransport(self._handler)
        return self._real(*args, **kwargs)


def _tags(*names: str) -> dict:
    return {"models": [{"name": n, "model": n} for n in names]}


def _check(handler, base_url: str = "http://localhost:11434/v1", model: str = "qwen2.5:3b"):
    factory = _MockClientFactory(handler)
    with mock.patch.object(ollama_health.httpx, "AsyncClient", factory):
        result = asyncio.run(agent.ollama_health(base_url=base_url, model=model))
    return result, factory


class OllamaHealthTests(unittest.TestCase):
    def test_ok_when_reachable_and_model_pulled(self) -> None:
        requests = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json=_tags("llama3:8b", "qwen2.5:3b"))

        result, _ = _check(handler)

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["model"], "qwen2.5:3b")
        # The native API lives at the root, not under the OpenAI-compatible /v1.
        self.assertEqual(str(requests[0].url), "http://localhost:11434/api/tags")

    def test_uses_the_configured_base_url(self) -> None:
        requests = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json=_tags("qwen2.5:3b"))

        result, _ = _check(handler, base_url="http://192.168.1.20:9999/v1/")

        self.assertEqual(result["status"], "ok")
        self.assertEqual(str(requests[0].url), "http://192.168.1.20:9999/api/tags")
        self.assertEqual(result["base_url"], "http://192.168.1.20:9999")

    def test_model_missing_when_not_pulled(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_tags("llama3:8b"))

        result, _ = _check(handler)

        self.assertEqual(result["status"], "model_missing")
        self.assertEqual(result["model"], "qwen2.5:3b")
        self.assertEqual(result["available"], ["llama3:8b"])

    def test_untagged_model_matches_latest(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_tags("mistral:latest"))

        result, _ = _check(handler, model="mistral")

        self.assertEqual(result["status"], "ok")

    def test_tagged_model_does_not_match_a_different_tag(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_tags("qwen2.5:latest"))

        result, _ = _check(handler, model="qwen2.5:3b")

        self.assertEqual(result["status"], "model_missing")

    def test_no_model_configured(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_tags("llama3:8b"))

        result, _ = _check(handler, model="  ")

        self.assertEqual(result["status"], "no_model")

    def test_unreachable_on_connection_error(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused", request=request)

        result, _ = _check(handler)

        self.assertEqual(result["status"], "unreachable")
        self.assertEqual(result["base_url"], "http://localhost:11434")
        self.assertIn("connection refused", result["detail"])

    def test_unreachable_on_timeout(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("timed out", request=request)

        result, _ = _check(handler)

        self.assertEqual(result["status"], "unreachable")

    def test_unreachable_when_something_else_answers(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(404, text="not found")

        result, _ = _check(handler)

        self.assertEqual(result["status"], "unreachable")
        self.assertIn("404", result["detail"])

    def test_unreachable_on_non_json_body(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, text="<html>hello</html>")

        result, _ = _check(handler)

        self.assertEqual(result["status"], "unreachable")

    def test_uses_a_short_timeout(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=_tags("qwen2.5:3b"))

        _, factory = _check(handler)

        timeout = factory.kwargs[0].get("timeout")
        self.assertIsNotNone(timeout)
        self.assertLessEqual(float(timeout), 5.0)


if __name__ == "__main__":
    unittest.main()
