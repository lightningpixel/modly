import asyncio
import json
import threading
import unittest
from unittest import mock

import httpx

import routers.agent as agent


def _sse(*deltas: dict) -> httpx.Response:
    """A streamed /chat/completions answer, one chunk per delta."""
    lines = [f"data: {json.dumps({'choices': [{'delta': d}]})}\n\n" for d in deltas]
    lines.append("data: [DONE]\n\n")
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        content="".join(lines).encode(),
    )


def _call(index: int, **fields) -> dict:
    return {"tool_calls": [{"index": index, **fields}]}


_WORKFLOWS = {"workflows": [{"id": "wf1", "name": "My Workflow"}]}


class _Scripted:
    """Patches httpx.AsyncClient to serve scripted responses in order, recording
    every request body."""

    def __init__(self, *responses: httpx.Response) -> None:
        self._responses = list(responses)
        self.bodies: list[dict] = []
        self._real = httpx.AsyncClient

    def _handler(self, request: httpx.Request) -> httpx.Response:
        self.bodies.append(json.loads(request.content))
        return self._responses.pop(0)

    def __call__(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(self._handler)
        return self._real(*args, **kwargs)


def _external(context=None) -> agent.AgentChatRequest:
    return agent.AgentChatRequest(
        messages=[agent.ChatMessage(role="user", content="hi")],
        model="gpt-test",
        provider=agent.ProviderConfig(type="external", base_url="https://llm.test/v1", api_key="k"),
        context=context or {},
    )


def _events(scripted: _Scripted, request: agent.AgentChatRequest) -> list[dict]:
    async def collect():
        return [event async for event in agent._chat_events(request)]

    with mock.patch.object(agent.httpx, "AsyncClient", scripted):
        return asyncio.run(collect())


def _text(events: list[dict], kind: str) -> str:
    return "".join(e["text"] for e in events if e["type"] == kind)


class ChatEventTests(unittest.TestCase):
    def test_answer_streams_token_by_token_then_done(self) -> None:
        scripted = _Scripted(_sse({"content": "Hel"}, {"content": "lo"}, {"content": " there"}))

        events = _events(scripted, _external())

        self.assertEqual([e["type"] for e in events], ["token", "token", "token", "done"])
        self.assertEqual(_text(events, "token"), "Hello there")
        self.assertEqual(events[-1]["message"], "Hello there")
        self.assertFalse(events[-1]["error"])
        self.assertTrue(scripted.bodies[0]["stream"])

    def test_reasoning_field_streams_as_thinking(self) -> None:
        events = _events(
            _Scripted(_sse({"reasoning_content": "Let me "}, {"reasoning_content": "think."}, {"content": "Hi"})),
            _external(),
        )

        self.assertEqual(_text(events, "thinking"), "Let me think.")
        self.assertEqual(_text(events, "token"), "Hi")
        self.assertEqual(events[-1]["thinking"], "Let me think.")

    def test_inline_think_tags_cut_across_chunks_are_split_out(self) -> None:
        events = _events(
            _Scripted(_sse({"content": "<thi"}, {"content": "nk>plan</th"}, {"content": "ink>\n\nHello <b>"})),
            _external(),
        )

        self.assertEqual(_text(events, "thinking"), "plan")
        # A "<" that turns out not to open a tag is still part of the answer.
        self.assertEqual(_text(events, "token"), "Hello <b>")
        self.assertEqual(events[-1]["message"], "Hello <b>")

    def test_fragmented_tool_call_is_reassembled_and_reported_around_its_run(self) -> None:
        scripted = _Scripted(
            _sse(
                {"content": "Starting it."},
                _call(0, id="call_1", type="function", function={"name": "run_workflow", "arguments": ""}),
                _call(0, function={"arguments": '{"workflow_'}),
                _call(0, function={"arguments": 'id": "wf1"}'}),
            ),
            _sse({"content": "Done."}),
        )

        events = _events(scripted, _external(_WORKFLOWS))

        types = [e["type"] for e in events]
        self.assertEqual(types, ["token", "tool_start", "tool_done", "token", "done"])
        start, finish = events[1], events[2]
        self.assertEqual((start["id"], start["tool"], start["arguments"]), ("call_1", "run_workflow", {"workflow_id": "wf1"}))
        self.assertEqual(finish["payload"]["type"], "run_workflow")
        # Rounds are set apart in the streamed text; the final answer is the last one.
        self.assertEqual(_text(events, "token"), "Starting it.\n\nDone.")
        self.assertEqual(events[-1]["message"], "Done.")
        self.assertEqual([a["tool"] for a in events[-1]["actions"]], ["run_workflow"])

        replay = scripted.bodies[1]["messages"]
        assistant = next(m for m in replay if m["role"] == "assistant")
        self.assertEqual(assistant["tool_calls"][0]["function"]["arguments"], '{"workflow_id": "wf1"}')
        self.assertEqual(replay[-1], {"role": "tool", "tool_call_id": "call_1", "content": finish["result"]})

    def test_tool_call_without_an_id_still_gets_its_result_matched(self) -> None:
        scripted = _Scripted(
            _sse(_call(0, function={"name": "run_workflow", "arguments": '{"workflow_id": "wf1"}'})),
            _sse({"content": "ok"}),
        )

        events = _events(scripted, _external(_WORKFLOWS))

        call_id = events[0]["id"]
        self.assertTrue(call_id)
        tool_message = scripted.bodies[1]["messages"][-1]
        self.assertEqual(tool_message["tool_call_id"], call_id)

    def test_reasoning_of_successive_rounds_is_separated(self) -> None:
        scripted = _Scripted(
            _sse({"reasoning_content": "first"}, _call(0, id="c", function={"name": "list_workflows", "arguments": "{}"})),
            _sse({"reasoning_content": "second"}, {"content": "ok"}),
        )

        with mock.patch.object(agent, "execute_tool", mock.AsyncMock(return_value=("none", None))):
            events = _events(scripted, _external())

        self.assertEqual(_text(events, "thinking"), "first\n\n---\n\nsecond")
        self.assertEqual(events[-1]["thinking"], "first\n\n---\n\nsecond")

    def test_provider_error_ends_with_an_error_done(self) -> None:
        events = _events(
            _Scripted(httpx.Response(401, json={"error": {"message": "Incorrect API key provided."}})),
            _external(),
        )

        self.assertEqual(len(events), 1)
        self.assertTrue(events[0]["error"])
        self.assertEqual(events[0]["message"], "LLM error (401): Incorrect API key provided.")

    def test_tool_loop_limit_is_reported_as_an_error(self) -> None:
        rounds = [
            _sse(_call(0, id=f"c{i}", function={"name": "list_workflows", "arguments": "{}"}))
            for i in range(10)
        ]
        with mock.patch.object(agent, "execute_tool", mock.AsyncMock(return_value=("none", None))):
            events = _events(_Scripted(*rounds), _external())

        self.assertTrue(events[-1]["error"])
        self.assertEqual(events[-1]["message"], "Reached maximum tool iterations.")
        self.assertEqual(len(events[-1]["actions"]), 10)

    def test_local_slot_is_released_when_the_client_disconnects(self) -> None:
        class Slot:
            base_url = "http://127.0.0.1:8791/v1"
            released = 0

            def release(self) -> None:
                self.released += 1

        slot = Slot()
        request = agent.AgentChatRequest(
            messages=[agent.ChatMessage(role="user", content="hi")], model="qwen3-4b"
        )

        async def first_event_then_disconnect():
            stream = agent._chat_events(request)
            first = await stream.__anext__()
            await stream.aclose()
            return first

        with mock.patch.object(agent.httpx, "AsyncClient", _Scripted(_sse({"content": "a"}, {"content": "b"}))), \
             mock.patch.object(agent.llm_server, "resolve_model", return_value={"vision": False}), \
             mock.patch.object(agent.llama_pool, "ensure", return_value=slot), \
             mock.patch.object(agent.llama_pool, "unload_all"):
            first = asyncio.run(first_event_then_disconnect())

        self.assertEqual(first, {"type": "token", "text": "a"})
        self.assertEqual(slot.released, 1)

    def test_slot_claimed_after_the_client_left_during_loading_is_released(self) -> None:
        class Slot:
            base_url = "http://127.0.0.1:8791/v1"
            released = 0

            def release(self) -> None:
                self.released += 1

        slot = Slot()
        loading, loaded = threading.Event(), threading.Event()

        def ensure(*_args):
            loading.set()
            loaded.wait(5)
            return slot

        request = agent.AgentChatRequest(
            messages=[agent.ChatMessage(role="user", content="hi")], model="qwen3-4b"
        )

        async def leave_while_loading():
            turn = asyncio.ensure_future(agent._chat_events(request).__anext__())
            await asyncio.to_thread(loading.wait, 5)
            turn.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await turn
            loaded.set()  # the model finishes loading after the client left
            for _ in range(200):
                if slot.released:
                    break
                await asyncio.sleep(0.01)

        with mock.patch.object(agent.llm_server, "resolve_model", return_value={"vision": False}), \
             mock.patch.object(agent.llama_pool, "ensure", ensure):
            asyncio.run(leave_while_loading())

        self.assertEqual(slot.released, 1)


class StreamRouteTests(unittest.TestCase):
    def test_stream_route_sends_one_json_event_per_data_line(self) -> None:
        async def read_body():
            response = await agent.agent_chat_stream(_external())
            self.assertEqual(response.media_type, "text/event-stream")
            return "".join([chunk async for chunk in response.body_iterator])

        with mock.patch.object(agent.httpx, "AsyncClient", _Scripted(_sse({"content": "Hi"}))):
            body = asyncio.run(read_body())

        blocks = [b for b in body.split("\n\n") if b]
        self.assertTrue(all(b.startswith("data: ") for b in blocks))
        events = [json.loads(b[len("data: "):]) for b in blocks]
        self.assertEqual([e["type"] for e in events], ["token", "done"])

    def test_json_route_returns_the_same_turn_at_once(self) -> None:
        scripted = _Scripted(
            _sse(_call(0, id="call_1", function={"name": "run_workflow", "arguments": '{"workflow_id": "wf1"}'})),
            _sse({"reasoning_content": "hm"}, {"content": "Running."}),
        )
        with mock.patch.object(agent.httpx, "AsyncClient", scripted):
            response = asyncio.run(agent.agent_chat(_external(_WORKFLOWS)))

        self.assertEqual(response.message, "Running.")
        self.assertEqual(response.thinking, "hm")
        self.assertEqual([a.tool for a in response.actions], ["run_workflow"])


class ThinkSplitterTests(unittest.TestCase):
    def test_partial_tag_is_held_until_it_resolves(self) -> None:
        splitter = agent._ThinkSplitter()

        self.assertEqual(splitter.feed("a<"), [("token", "a")])
        self.assertEqual(splitter.feed("think>b"), [("thinking", "b")])
        self.assertEqual(splitter.feed("</"), [])
        self.assertEqual(splitter.flush(), [("thinking", "</")])

    def test_closing_tag_without_an_opening_one_is_never_shown(self) -> None:
        # The chat template opened <think> in the prompt, so only its end streams.
        splitter = agent._ThinkSplitter()
        self.assertEqual(splitter.feed("plan</think>\n\nAnswer"), [("thinking", "plan"), ("token", "\n\nAnswer")])

        # Reasoning that streamed before the tag was already shown; the tag is not.
        splitter = agent._ThinkSplitter()
        parts = splitter.feed("plan</thi") + splitter.feed("nk>Answer") + splitter.flush()
        self.assertEqual(parts, [("token", "plan"), ("token", "Answer")])


if __name__ == "__main__":
    unittest.main()
