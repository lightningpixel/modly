import asyncio
import json
import unittest
from unittest import mock

import httpx

import routers.agent as agent


class _ScriptedServer:
    """MockTransport wiring: serves a scripted /chat/completions sequence and
    records every request body agent_chat sends."""

    def __init__(self, chat_bodies) -> None:
        self._chat = list(chat_bodies)
        self.requests: list[dict] = []
        self._real = httpx.AsyncClient

    def _handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/chat/completions"):
            self.requests.append({"headers": dict(request.headers), "body": json.loads(request.content)})
            return httpx.Response(200, json=self._chat.pop(0))
        return httpx.Response(404, json={})

    def __call__(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(self._handler)
        return self._real(*args, **kwargs)


class _FakeSlot:
    base_url = "http://127.0.0.1:8791/v1"

    def __init__(self) -> None:
        self.released = 0

    def release(self) -> None:
        self.released += 1


def _assistant(content: str = "", tool_calls=None) -> dict:
    msg: dict = {"role": "assistant", "content": content}
    if tool_calls:
        msg["tool_calls"] = tool_calls
    return {"choices": [{"message": msg}]}


_RUN_WF1 = {"id": "call_1", "type": "function", "function": {"name": "run_workflow", "arguments": '{"workflow_id": "wf1"}'}}
_SPEC = {"vision": False}


def _run_local(chat_bodies, context):
    scripted = _ScriptedServer(chat_bodies)
    slot = _FakeSlot()
    request = agent.AgentChatRequest(
        messages=[agent.ChatMessage(role="user", content="make me a thing")],
        model="qwen3-4b",
        context=context,
    )
    with mock.patch.object(agent.httpx, "AsyncClient", scripted), \
         mock.patch.object(agent.llm_server, "resolve_model", return_value=_SPEC), \
         mock.patch.object(agent.llama_pool, "ensure", return_value=slot), \
         mock.patch.object(agent.llama_pool, "unload_all") as unload_all:
        response = asyncio.run(agent.agent_chat(request))
    return scripted, slot, unload_all, response


class WorkflowVramUnloadTests(unittest.TestCase):
    def test_llm_unloaded_on_the_normal_return_after_a_workflow(self) -> None:
        # Round 1 dispatches a workflow; round 2 is the final answer (no tools) and
        # returns early. The VRAM unload must still fire on that path.
        chat = [_assistant(tool_calls=[_RUN_WF1]), _assistant(content="Running your workflow now.")]
        _, slot, unload_all, response = _run_local(chat, {"workflows": [{"id": "wf1", "name": "My Workflow"}]})
        unload_all.assert_called_once()
        self.assertEqual(slot.released, 1)
        self.assertEqual([a.tool for a in response.actions], ["run_workflow"])

    def test_slot_is_released_before_the_unload(self) -> None:
        # unload_all() spares held slots, so unloading before the release kept
        # the agent's own model on the GPU through the whole workflow.
        chat = [_assistant(tool_calls=[_RUN_WF1]), _assistant(content="ok")]
        released_at_unload: list[int] = []
        slot = _FakeSlot()
        request = agent.AgentChatRequest(
            messages=[agent.ChatMessage(role="user", content="go")],
            model="qwen3-4b",
            context={"workflows": [{"id": "wf1", "name": "My Workflow"}]},
        )
        with mock.patch.object(agent.httpx, "AsyncClient", _ScriptedServer(chat)), \
             mock.patch.object(agent.llm_server, "resolve_model", return_value=_SPEC), \
             mock.patch.object(agent.llama_pool, "ensure", return_value=slot), \
             mock.patch.object(agent.llama_pool, "unload_all", lambda: released_at_unload.append(slot.released)):
            asyncio.run(agent.agent_chat(request))
        self.assertEqual(released_at_unload, [1])

    def test_no_unload_when_no_workflow_was_dispatched(self) -> None:
        _, slot, unload_all, _ = _run_local([_assistant(content="Here is some info.")], {})
        unload_all.assert_not_called()
        self.assertEqual(slot.released, 1)

    def test_a_single_system_message_leads_the_conversation(self) -> None:
        # Qwen3.5's template rejects a system message anywhere but first (HTTP 400).
        context = {"currentMeshPath": "/tmp/a.glb", "extensions": [{"id": "remesh", "name": "Remesh"}]}
        scripted, *_ = _run_local([_assistant(content="ok")], context)
        roles = [m["role"] for m in scripted.requests[0]["body"]["messages"]]
        self.assertEqual(roles, ["system", "user"])
        system = scripted.requests[0]["body"]["messages"][0]["content"]
        self.assertIn("Current mesh path: /tmp/a.glb", system)
        self.assertIn("remesh", system)

    def test_tool_result_answers_its_call_id(self) -> None:
        chat = [_assistant(tool_calls=[_RUN_WF1]), _assistant(content="done")]
        scripted, *_ = _run_local(chat, {"workflows": [{"id": "wf1", "name": "My Workflow"}]})
        tool_msgs = [m for m in scripted.requests[1]["body"]["messages"] if m["role"] == "tool"]
        self.assertEqual(tool_msgs[0]["tool_call_id"], "call_1")


class ExternalProviderTests(unittest.TestCase):
    def test_external_provider_sends_the_key_and_never_touches_the_local_pool(self) -> None:
        scripted = _ScriptedServer([_assistant(tool_calls=[_RUN_WF1]), _assistant(content="ok")])
        request = agent.AgentChatRequest(
            messages=[agent.ChatMessage(role="user", content="hi")],
            model="gpt-test",
            provider=agent.ProviderConfig(type="external", base_url="https://llm.test/v1/", api_key="sk-test"),
            context={"workflows": [{"id": "wf1", "name": "My Workflow"}]},
        )
        with mock.patch.object(agent.httpx, "AsyncClient", scripted), \
             mock.patch.object(agent.llama_pool, "ensure") as ensure, \
             mock.patch.object(agent.llama_pool, "unload_all") as unload_all:
            response = asyncio.run(agent.agent_chat(request))
        self.assertEqual(response.message, "ok")
        self.assertEqual(scripted.requests[0]["headers"]["authorization"], "Bearer sk-test")
        ensure.assert_not_called()
        unload_all.assert_not_called()

    def test_text_only_provider_gets_a_retry_without_the_image(self) -> None:
        bodies: list[dict] = []

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            bodies.append(body)
            if isinstance(body["messages"][1]["content"], list):
                return httpx.Response(400, json={"error": {"message": "image input not supported"}})
            return httpx.Response(200, json=_assistant(content="ok"))

        real = httpx.AsyncClient
        request = agent.AgentChatRequest(
            messages=[agent.ChatMessage(role="user", content="what is this", images=["data:image/png;base64,AAAA"])],
            model="text-only",
            provider=agent.ProviderConfig(type="external", base_url="https://llm.test/v1", api_key="k"),
        )
        with mock.patch.object(agent.httpx, "AsyncClient", lambda *a, **k: real(*a, transport=httpx.MockTransport(handler), **k)):
            response = asyncio.run(agent.agent_chat(request))
        self.assertEqual(response.message, "ok")
        self.assertEqual(len(bodies), 2)
        self.assertIn("what is this", bodies[1]["messages"][1]["content"])

    def test_provider_error_shows_its_message_not_raw_json(self) -> None:
        def handler(_: httpx.Request) -> httpx.Response:
            return httpx.Response(401, json={"error": {"message": "Incorrect API key provided.", "type": "invalid_request_error"}})

        real = httpx.AsyncClient
        request = agent.AgentChatRequest(
            messages=[agent.ChatMessage(role="user", content="hi")],
            provider=agent.ProviderConfig(type="external", base_url="https://llm.test/v1", api_key="bad"),
        )
        with mock.patch.object(agent.httpx, "AsyncClient", lambda *a, **k: real(*a, transport=httpx.MockTransport(handler), **k)):
            response = asyncio.run(agent.agent_chat(request))
        self.assertEqual(response.message, "LLM error (401): Incorrect API key provided.")

    def test_missing_provider_url_is_reported(self) -> None:
        request = agent.AgentChatRequest(
            messages=[agent.ChatMessage(role="user", content="hi")],
            provider=agent.ProviderConfig(type="external"),
        )
        response = asyncio.run(agent.agent_chat(request))
        self.assertIn("No provider URL", response.message)


if __name__ == "__main__":
    unittest.main()
