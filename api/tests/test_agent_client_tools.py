import asyncio
import json
import unittest
from unittest import mock

import httpx
from fastapi import HTTPException

import routers.agent as agent
from tests.test_agent_streaming import _call, _external, _Scripted, _sse


def _client_round(name: str, arguments: dict | None = None, call_id: str = "c1") -> httpx.Response:
    return _sse(_call(0, id=call_id, function={"name": name, "arguments": json.dumps(arguments or {})}))


async def _answer(call_id: str, result: str, error: bool = False) -> dict:
    return await agent.agent_tool_result(agent.ToolResultRequest(call_id=call_id, result=result, error=error))


def _run_turn(scripted: _Scripted, request: agent.AgentChatRequest, on_client_tool) -> list[dict]:
    """Drive a turn, letting `on_client_tool(event)` answer each client tool
    the way the panel would (it may be a coroutine function)."""

    async def collect():
        events = []
        async for event in agent._chat_events(request):
            events.append(event)
            if event["type"] == "client_tool":
                answered = on_client_tool(event)
                if asyncio.iscoroutine(answered):
                    await answered
        return events

    with mock.patch.object(agent.httpx, "AsyncClient", scripted):
        return asyncio.run(collect())


class ClientToolBridgeTests(unittest.TestCase):
    def tearDown(self) -> None:
        agent._pending_client_tools.clear()

    def test_client_tool_is_handed_to_the_app_and_its_answer_reaches_the_model(self) -> None:
        scripted = _Scripted(
            _client_round("install_extension", {"github_url": "https://github.com/a/b"}),
            _sse({"content": "Installed."}),
        )
        execute = mock.AsyncMock(return_value=("never", None))
        answers = []

        async def answer(event):
            answers.append(await _answer(event["call_id"], "Installed b v1.0."))

        with mock.patch.object(agent, "execute_tool", execute):
            events = _run_turn(scripted, _external(), answer)

        execute.assert_not_awaited()
        self.assertEqual([e["type"] for e in events], ["tool_start", "client_tool", "tool_done", "token", "done"])
        handoff = events[1]
        self.assertEqual(
            {k: v for k, v in handoff.items() if k != "call_id"},
            {
                "type": "client_tool", "id": "c1", "tool": "install_extension",
                "arguments": {"github_url": "https://github.com/a/b"}, "confirm": True,
            },
        )
        self.assertRegex(handoff["call_id"], r"^[0-9a-f]{32}$")
        self.assertEqual(answers, [{"ok": True}])
        self.assertEqual(events[2]["result"], "Installed b v1.0.")
        self.assertEqual(events[-1]["actions"][0]["tool"], "install_extension")
        self.assertEqual(
            scripted.bodies[1]["messages"][-1],
            {"role": "tool", "tool_call_id": "c1", "content": "Installed b v1.0."},
        )
        self.assertEqual(agent._pending_client_tools, {})

    def test_answer_while_the_turn_is_waiting(self) -> None:
        scripted = _Scripted(_client_round("reload_extensions"), _sse({"content": "ok"}))

        def answer_later(event):
            async def later():
                await asyncio.sleep(0.01)
                await _answer(event["call_id"], "Reloaded.")
            asyncio.ensure_future(later())

        events = _run_turn(scripted, _external(), answer_later)

        self.assertEqual(scripted.bodies[1]["messages"][-1]["content"], "Reloaded.")
        self.assertFalse(events[-1]["error"])

    def test_destructive_tool_asks_for_confirmation_and_a_decline_is_relayed(self) -> None:
        scripted = _Scripted(
            _client_round("uninstall_extension", {"extension_id": "x"}),
            _sse({"content": "Kept it."}),
        )
        events = _run_turn(scripted, _external(), lambda e: _answer(e["call_id"], "The user declined."))

        handoff = next(e for e in events if e["type"] == "client_tool")
        self.assertTrue(handoff["confirm"])
        self.assertEqual(scripted.bodies[1]["messages"][-1]["content"], "The user declined.")

    def test_error_answer_is_prefixed(self) -> None:
        scripted = _Scripted(_client_round("reload_extensions"), _sse({"content": "ok"}))
        events = _run_turn(scripted, _external(), lambda e: _answer(e["call_id"], "disk full", error=True))

        self.assertEqual(events[2]["result"], "Error: disk full")
        self.assertEqual(scripted.bodies[1]["messages"][-1]["content"], "Error: disk full")

    def test_unknown_or_already_answered_call_is_404(self) -> None:
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(_answer("nope", "x"))
        self.assertEqual(caught.exception.status_code, 404)

        seen = []

        async def answer_twice(event):
            await _answer(event["call_id"], "first")
            try:
                await _answer(event["call_id"], "second")
            except HTTPException as e:
                seen.append(e.status_code)

        _run_turn(_Scripted(_client_round("reload_extensions"), _sse({"content": "ok"})), _external(), answer_twice)
        self.assertEqual(seen, [404])

    def test_unanswered_tool_times_out_and_the_loop_continues(self) -> None:
        scripted = _Scripted(_client_round("reload_extensions"), _sse({"content": "It did not answer."}))
        events = _run_turn(scripted, _external().model_copy(update={"tool_timeout": 0.05}), lambda e: None)

        finish = next(e for e in events if e["type"] == "tool_done")
        self.assertEqual(finish["result"], "Error: The app did not answer in time.")
        self.assertIsNone(finish["error"])
        done = events[-1]
        self.assertFalse(done["error"])
        self.assertIsNone(done["stopped"])
        self.assertEqual(done["message"], "It did not answer.")
        self.assertEqual(scripted.bodies[1]["messages"][-1]["content"], "Error: The app did not answer in time.")
        self.assertEqual(agent._pending_client_tools, {})

    def test_confirm_tools_wait_for_the_confirm_cap_not_the_tool_timeout(self) -> None:
        scripted = _Scripted(_client_round("delete_workflow", {"workflow_id": "w"}), _sse({"content": "ok"}))

        def answer_after_tool_timeout(event):
            async def later():
                await asyncio.sleep(0.15)
                await _answer(event["call_id"], "Deleted.")
            asyncio.ensure_future(later())

        with mock.patch.object(agent, "CONFIRM_TIMEOUT", 5.0):
            _run_turn(scripted, _external().model_copy(update={"tool_timeout": 0.05}), answer_after_tool_timeout)

        self.assertEqual(scripted.bodies[1]["messages"][-1]["content"], "Deleted.")

    def test_confirm_wait_is_capped(self) -> None:
        self.assertEqual(agent.CONFIRM_TIMEOUT, 600)
        scripted = _Scripted(_client_round("delete_workflow", {"workflow_id": "w"}), _sse({"content": "ok"}))
        with mock.patch.object(agent, "CONFIRM_TIMEOUT", 0.05):
            events = _run_turn(scripted, _external(), lambda e: None)

        self.assertEqual(events[2]["result"], "Error: The app did not answer in time.")

    def test_client_tools_count_against_the_budget(self) -> None:
        both = _sse(
            _call(0, id="a", function={"name": "reload_extensions", "arguments": "{}"}),
            _call(1, id="b", function={"name": "undo_mesh", "arguments": "{}"}),
        )
        events = _run_turn(
            _Scripted(both), _external().model_copy(update={"tool_budget": 1}),
            lambda e: _answer(e["call_id"], "ok"),
        )

        self.assertEqual(sum(e["type"] == "client_tool" for e in events), 1)
        self.assertEqual(events[-1]["stopped"]["code"], "tool_budget_exhausted")
        self.assertEqual(events[-1]["stopped"]["tool"], "undo_mesh")

    def test_closing_the_stream_while_a_tool_waits_cancels_it(self) -> None:
        async def leave_at_handoff():
            stream = agent._chat_events(_external())
            async for event in stream:
                if event["type"] == "client_tool":
                    future = agent._pending_client_tools[event["call_id"]]
                    await stream.aclose()
                    return event, future

        with mock.patch.object(agent.httpx, "AsyncClient", _Scripted(_client_round("reload_extensions"))):
            event, future = asyncio.run(leave_at_handoff())

        self.assertTrue(future.cancelled())
        self.assertNotIn(event["call_id"], agent._pending_client_tools)

    def test_cancelling_the_turn_while_it_awaits_the_app_cancels_the_future(self) -> None:
        async def cancel_while_waiting():
            stream = agent._chat_events(_external())
            while (event := await stream.__anext__())["type"] != "client_tool":
                pass
            future = agent._pending_client_tools[event["call_id"]]
            waiting = asyncio.ensure_future(stream.__anext__())
            await asyncio.sleep(0.01)
            waiting.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await waiting
            return event, future

        with mock.patch.object(agent.httpx, "AsyncClient", _Scripted(_client_round("reload_extensions"))):
            event, future = asyncio.run(cancel_while_waiting())

        self.assertTrue(future.cancelled())
        self.assertNotIn(event["call_id"], agent._pending_client_tools)


_CLIENT_TOOL_ARGS = {
    "install_extension": ["github_url"],
    "uninstall_extension": ["extension_id"],
    "reload_extensions": [],
    "download_model_weights": ["extension_id", "variant"],
    "delete_model_weights": ["extension_id", "variant"],
    "delete_workflow": ["workflow_id"],
    "open_workflow": ["workflow_id"],
    "set_setting": ["key", "value"],
    "set_storage_folder": ["kind", "path"],
    "undo_mesh": [],
    "redo_mesh": [],
    "navigate": ["page"],
}


class ClientToolDeclarationTests(unittest.TestCase):
    def _tool(self, name: str) -> dict:
        return next(t["function"] for t in agent.TOOLS if t["function"]["name"] == name)

    def test_every_client_tool_is_declared_with_its_confirmation(self) -> None:
        self.assertEqual(set(agent.CLIENT_TOOLS), set(_CLIENT_TOOL_ARGS))
        confirmed = {name for name, confirm in agent.CLIENT_TOOLS.items() if confirm}
        self.assertEqual(
            confirmed,
            # install_extension runs code downloaded from GitHub: never without a click.
            {"install_extension", "uninstall_extension", "delete_model_weights", "delete_workflow", "set_storage_folder"},
        )

    def test_every_client_tool_has_a_schema(self) -> None:
        for name, args in _CLIENT_TOOL_ARGS.items():
            with self.subTest(name=name):
                fn = self._tool(name)
                self.assertTrue(fn["description"])
                self.assertEqual(sorted(fn["parameters"]["properties"]), sorted(args))

    def test_enums(self) -> None:
        props = self._tool("set_setting")["parameters"]["properties"]
        self.assertEqual(props["key"]["enum"], ["uiScale", "useAtkinsonFont", "showRamIndicator"])
        # The app's scale names, not a number: the frontend accepts only these.
        self.assertEqual(props["value"]["type"], ["string", "boolean"])
        self.assertIn("small, medium, large, very-large", props["value"]["description"])
        props = self._tool("set_storage_folder")["parameters"]["properties"]
        self.assertEqual(props["kind"]["enum"], ["models", "workspace", "workflows"])
        nav = self._tool("navigate")
        self.assertEqual(nav["parameters"]["properties"]["page"]["enum"], ["generate", "workflows", "models", "settings"])
        self.assertIn("ONLY", nav["description"])

    def test_tool_names_are_unique(self) -> None:
        names = [t["function"]["name"] for t in agent.TOOLS]
        self.assertEqual(len(names), len(set(names)))

    def test_system_prompt_lists_the_new_tools(self) -> None:
        for name in [*_CLIENT_TOOL_ARGS, "list_extensions", "get_settings", "generate_from_image"]:
            with self.subTest(name=name):
                self.assertIn(name, agent.SYSTEM_PROMPT)
        self.assertIn("declined", agent.SYSTEM_PROMPT)


_CONTEXT = {
    "extensions": [{"id": "trellis/gen", "name": "Trellis", "input": "image", "output": "mesh"}],
    "models": [{"id": "trellis", "name": "Trellis 2"}, {"id": "sf3d", "name": "SF3D"}],
    "storage": {
        "modelsDir": "D:/models", "workspaceDir": "D:/ws",
        "workflowsDir": "D:/wf", "extensionsDir": "D:/ext",
    },
    "ui": {"uiScale": "large", "useAtkinsonFont": False, "showRamIndicator": True},
}


def _run(name: str, arguments: dict | None = None, context: dict | None = None, **kwargs):
    return asyncio.run(agent.execute_tool(name, arguments or {}, _CONTEXT if context is None else context, **kwargs))


class ServerToolTests(unittest.TestCase):
    def test_list_extensions(self) -> None:
        text, payload = _run("list_extensions")
        self.assertIn("- trellis/gen (image→mesh): Trellis", text)
        self.assertIsNone(payload)
        self.assertIn("No extensions", _run("list_extensions", context={})[0])

    def test_get_settings(self) -> None:
        text, payload = _run("get_settings")
        for expected in ("D:/models", "D:/ws", "D:/wf", "D:/ext", "uiScale: large", "useAtkinsonFont: false", "showRamIndicator: true"):
            self.assertIn(expected, text)
        self.assertIsNone(payload)
        self.assertIn("No settings", _run("get_settings", context={})[0])

    def test_generate_from_image_needs_an_attached_image(self) -> None:
        text, payload = _run("generate_from_image")
        self.assertIsNone(payload)
        self.assertIn("attach", text.lower())

    def test_generate_from_image_hands_the_run_to_the_app(self) -> None:
        text, payload = _run("generate_from_image", {"model_id": "sf3d"}, has_image=True)
        self.assertEqual(payload, {"type": "generate_from_image", "model_id": "sf3d"})
        self.assertIn("SF3D", text)

        text, payload = _run("generate_from_image", has_image=True)
        self.assertEqual(payload, {"type": "generate_from_image", "model_id": None})

    def test_generate_from_image_rejects_an_unknown_model(self) -> None:
        text, payload = _run("generate_from_image", {"model_id": "ghost"}, has_image=True)
        self.assertIsNone(payload)
        self.assertIn("ghost", text)
        self.assertIn("trellis", text)

    def test_the_turn_tells_the_tool_whether_the_last_user_message_has_an_image(self) -> None:
        def turn(messages):
            request = _external().model_copy(update={"messages": messages})
            tool = mock.AsyncMock(return_value=("ok", None))
            with mock.patch.object(agent, "execute_tool", tool):
                _run_turn(_Scripted(_client_round("generate_from_image"), _sse({"content": "ok"})), request, None)
            return tool.await_args.kwargs["has_image"]

        img = "data:image/png;base64,AAAA"
        self.assertTrue(turn([agent.ChatMessage(role="user", content="go", images=[img])]))
        self.assertFalse(turn([
            agent.ChatMessage(role="user", content="a", images=[img]),
            agent.ChatMessage(role="assistant", content="b"),
            agent.ChatMessage(role="user", content="now generate"),
        ]))


class ContextRenderingTests(unittest.TestCase):
    def test_context_is_rendered_into_the_single_system_message(self) -> None:
        context = {
            **_CONTEXT,
            "page": "models",
            "workflows": [{"id": "wf1", "name": "My Workflow"}],
            "currentMeshPath": "Default/mesh.glb",
        }
        scripted = _Scripted(_sse({"content": "hi"}))
        _run_turn(scripted, _external(context), None)

        messages = scripted.bodies[0]["messages"]
        self.assertEqual(sum(m["role"] == "system" for m in messages), 1)
        system = messages[0]["content"]
        for expected in (
            "Current page: models",
            "- trellis: Trellis 2",
            "- sf3d: SF3D",
            "- wf1: My Workflow",
            "D:/models", "D:/ws", "D:/wf", "D:/ext",
            "uiScale: large", "useAtkinsonFont: false", "showRamIndicator: true",
            "Current mesh path: Default/mesh.glb",
            "- trellis/gen (image→mesh): Trellis",
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, system)

    def test_empty_context_adds_nothing(self) -> None:
        scripted = _Scripted(_sse({"content": "hi"}))
        _run_turn(scripted, _external(), None)
        self.assertEqual(scripted.bodies[0]["messages"][0]["content"], agent.SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
