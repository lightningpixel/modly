import asyncio
import unittest
from unittest import mock

import httpx

import routers.agent as agent


class _MockClientFactory:
    """Builds real AsyncClients wired to a MockTransport, so execute_tool talks to
    a fake Modly API instead of the network."""

    def __init__(self, handler) -> None:
        self._handler = handler
        self._real = httpx.AsyncClient

    def __call__(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(self._handler)
        return self._real(*args, **kwargs)


def _run_tool(name: str, handler) -> tuple[str, object]:
    factory = _MockClientFactory(handler)
    with mock.patch.object(agent.httpx, "AsyncClient", factory):
        return asyncio.run(agent.execute_tool(name, {}, {}))


class UnloadModelsErrorTests(unittest.TestCase):
    """unload_models must report a failed unload, not claim success (like every
    other POST tool and like the MCP server's modly_unload_models)."""

    def test_http_error_is_surfaced(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="boom")

        text, payload = _run_tool("unload_models", handler)
        # Before the fix the response was discarded and the success string was
        # returned even on a 500; now the shared HTTPStatusError handler runs.
        self.assertTrue(text.startswith("API error 500"), text)
        self.assertIsNone(payload)

    def test_success_still_reports_unloaded(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"ok": True})

        text, payload = _run_tool("unload_models", handler)
        self.assertIn("unloaded", text.lower())
        self.assertIsNone(payload)


if __name__ == "__main__":
    unittest.main()
