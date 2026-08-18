"""Pure grading logic for the agent eval harness.

Kept free of I/O so it can be unit-tested offline (see tests/test_evals_grader.py)
against synthetic transcripts, independent of any live model.
"""
import json
from typing import Optional

_PARAM_ERROR_MARKERS = ("Unknown param", "Invalid value", "below the minimum", "above the maximum")


def _subset(expected, actual) -> bool:
    """True when `expected` is contained in `actual`.

    Dicts match on the keys they declare (extra keys in `actual` are fine), lists
    match when every expected element is contained in some actual element, and
    scalars match on equality. Lets a case assert `{"set_params": [{"step": 1,
    "params": {"resolution": 2048}}]}` without spelling out the whole payload.
    """
    if isinstance(expected, dict):
        if not isinstance(actual, dict):
            return False
        return all(k in actual and _subset(v, actual[k]) for k, v in expected.items())
    if isinstance(expected, list):
        if not isinstance(actual, list):
            return False
        return all(any(_subset(e, a) for a in actual) for e in expected)
    return expected == actual


def grade(case: dict, actions: list[dict], final: str, error: Optional[str]) -> tuple[bool, list[str]]:
    """Return (passed, reasons). `actions` is [{tool, result, payload}, …] as
    emitted by the agent's SSE 'action' events; `final` is the 'done' message."""
    reasons: list[str] = []
    expect = case.get("expect", {})
    tool_names = [a.get("tool") for a in actions]
    results = [str(a.get("result", "")) for a in actions]

    if error and not expect.get("allow_error"):
        reasons.append(f"stream error: {error}")

    for tool in expect.get("tools_include", []):
        if tool not in tool_names:
            reasons.append(f"missing expected tool call: {tool}")

    for tool in expect.get("tools_exclude", []):
        if tool in tool_names:
            reasons.append(f"unexpected tool call: {tool}")

    if expect.get("no_param_error"):
        bad = [r for r in results if any(m in r for m in _PARAM_ERROR_MARKERS)]
        if bad:
            reasons.append(f"param error surfaced: {bad[0][:100]}")

    # Asserts the mutation the agent actually emitted, not just which tool it
    # picked. Constrained decoding can force a valid-but-wrong param id, which
    # raises no error at all — without this key `no_param_error` would go
    # vacuously true and a quality regression would read as an improvement.
    payloads = [a.get("payload") for a in actions if a.get("payload")]
    for want in expect.get("payload_includes", []):
        if not any(_subset(want, p) for p in payloads):
            reasons.append(f"no action payload matched: {json.dumps(want, sort_keys=True)}")

    # The mirror of payload_includes, for cases about *which* extension was
    # picked among several with the same signature. Asserting only that the right
    # one is present passes a chain that also bolted on the two wrong ones, so a
    # disambiguation case has to be able to name what must be absent.
    for unwanted in expect.get("payload_excludes", []):
        if any(_subset(unwanted, p) for p in payloads):
            reasons.append(f"action payload contained: {json.dumps(unwanted, sort_keys=True)}")

    # The mutation that must NOT have happened. `tools_exclude` is too strict for
    # this: attempting a tool and being rejected by its validation is a fine
    # outcome — only an emitted payload actually changes the app's state.
    for kind in expect.get("payloads_exclude", []):
        if any(isinstance(p, dict) and p.get("type") == kind for p in payloads):
            reasons.append(f"unexpected {kind} payload")

    for sub in expect.get("final_includes", []):
        if sub.lower() not in (final or "").lower():
            reasons.append(f"final message missing substring: {sub!r}")

    if expect.get("no_tools") and tool_names:
        reasons.append(f"expected no tool calls, got: {', '.join(map(str, tool_names))}")

    return (len(reasons) == 0, reasons)
