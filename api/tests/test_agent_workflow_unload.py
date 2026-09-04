import asyncio
import json
import unittest
from unittest import mock

import httpx

import routers.agent as agent


class _ScriptedOllama:
    """MockTransport wiring: serves a scripted /api/chat sequence and records
    every /api/generate (VRAM keep_alive) call agent_chat makes."""

    def __init__(self, chat_bodies) -> None:
        self._chat = list(chat_bodies)
        self.generate_calls: list[dict] = []
        self._real = httpx.AsyncClient

    def _handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/chat":
            return httpx.Response(200, json=self._chat.pop(0))
        if path == "/api/generate":
            self.generate_calls.append(json.loads(request.content))
            return httpx.Response(200, json={})
        return httpx.Response(404, json={})

    def __call__(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(self._handler)
        return self._real(*args, **kwargs)


def _assistant(content: str = "", tool_calls=None) -> dict:
    msg: dict = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return {"message": msg}


def _run(chat_bodies, context) -> _ScriptedOllama:
    scripted = _ScriptedOllama(chat_bodies)
    request = agent.AgentChatRequest(
        messages=[agent.ChatMessage(role="user", content="make me a thing")],
        ollama_url="http://ollama.test",
        model="llama-test",
        context=context,
    )
    with mock.patch.object(agent.httpx, "AsyncClient", scripted):
        asyncio.run(agent.agent_chat(request))
    return scripted


class WorkflowVramUnloadTests(unittest.TestCase):
    def test_llm_unloaded_on_the_normal_return_after_a_workflow(self) -> None:
        # Round 1 dispatches a workflow; round 2 is the final answer (no tools) and
        # returns early. The VRAM unload must still fire — before the fix it lived
        # after the loop and this common path skipped it entirely.
        chat = [
            _assistant(tool_calls=[
                {"function": {"name": "run_workflow", "arguments": {"workflow_id": "wf1"}}},
            ]),
            _assistant(content="Running your workflow now."),
        ]
        scripted = _run(chat, {"workflows": [{"id": "wf1", "name": "My Workflow"}]})
        self.assertTrue(
            any(call.get("keep_alive") == 0 for call in scripted.generate_calls),
            f"expected a keep_alive:0 unload, got {scripted.generate_calls}",
        )

    def test_no_unload_when_no_workflow_was_dispatched(self) -> None:
        scripted = _run([_assistant(content="Here is some info.")], {})
        self.assertEqual(scripted.generate_calls, [])


if __name__ == "__main__":
    unittest.main()
