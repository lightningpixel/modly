#!/usr/bin/env python3
"""Does this llama.cpp build honour `enum` inside a TOOL argument?

The whole point of dynamic enums (`_DYNAMIC_ENUMS` in routers/agent.py) is that
llama.cpp turns a tool's JSON schema into a GBNF grammar, making an id outside
the enum impossible to emit. That is what the docs say. `tool_choice: "required"`
also looked supported and silently wasn't — it was honoured with one tool and
ignored with fifteen. So measure it before trusting it.

Runs straight against the managed llama-server (NOT /agent/chat), because we are
testing the inference server, not Modly's loop.

    cd api
    python evals/spike_enums.py                 # finds the port via /llm/status
    python evals/spike_enums.py --samples 20

Sampling is at temperature 1.0 on purpose: at the production 0.2 the model looks
compliant for reasons that have nothing to do with the grammar.

Exit code 0 = enums held on every test. Then set MODLY_AGENT_ENUMS=1 (or flip
_DYNAMIC_ENUMS) and re-run the evals to measure the gain.
"""
import argparse
import json
import sys

import httpx

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# The two ids the model is allowed to emit, and the one it will be pushed toward.
ALLOWED = ["wf-aaa", "wf-bbb"]
DECOY = "wf-zzz"


def _tool(name: str, props: dict, required: list) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": f"{name} — spike probe.",
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }


def _filler(n: int) -> list[dict]:
    """Plausible distractor tools, to reproduce a realistic list length."""
    names = [
        "list_workflows", "get_workflow_details", "get_extension_params", "create_workflow",
        "update_workflow", "set_param", "fix_workflow_wiring", "continue_workflow",
        "decimate_mesh", "smooth_mesh", "unload_models", "remember", "recall",
    ]
    return [_tool(n_, {"q": {"type": "string", "description": "argument"}}, []) for n_ in names[:n]]


def probe(base: str, model: str, tools: list, user: str, samples: int, temperature: float):
    """Call the server `samples` times, return the list of tool-call argument dicts."""
    out = []
    with httpx.Client(timeout=120.0) as c:
        for _ in range(samples):
            r = c.post(f"{base}/v1/chat/completions", json={
                "model": model,
                "messages": [{"role": "user", "content": user}],
                "tools": tools,
                "temperature": temperature,
            })
            if r.status_code != 200:
                out.append({"__http__": r.status_code, "__body__": r.text[:200]})
                continue
            calls = (r.json().get("choices") or [{}])[0].get("message", {}).get("tool_calls") or []
            if not calls:
                out.append({"__no_tool_call__": True})
                continue
            try:
                out.append(json.loads(calls[0]["function"]["arguments"] or "{}"))
            except ValueError as e:
                out.append({"__bad_json__": str(e)})
    return out


def report(title: str, results: list, ok_pred, detail: str = "") -> bool:
    bad = [r for r in results if not ok_pred(r)]
    ok = not bad
    print(f"{'✓' if ok else '✗'} {title}  ({len(results) - len(bad)}/{len(results)})")
    if detail:
        print(f"    {detail}")
    for r in bad[:5]:
        print(f"    got: {json.dumps(r, ensure_ascii=False)[:160]}")
    return ok


def find_port(api_url: str) -> str | None:
    try:
        r = httpx.get(f"{api_url.rstrip('/')}/llm/status", timeout=10.0)
        r.raise_for_status()
        st = r.json()
    except Exception as e:  # noqa: BLE001
        print(f"Could not reach {api_url}/llm/status: {e}")
        return None
    for key in ("base_url", "url"):
        if st.get(key):
            return str(st[key]).rstrip("/")
    port = st.get("port") or (st.get("slots") or [{}])[0].get("port")
    return f"http://127.0.0.1:{port}" if port else None


def main() -> None:
    ap = argparse.ArgumentParser(description="Verify llama.cpp honours enums in tool arguments")
    ap.add_argument("--api", default="http://localhost:8765", help="Modly API, used to locate the llama-server")
    ap.add_argument("--base", default=None, help="llama-server base URL (skips discovery)")
    ap.add_argument("--model", default="qwen3-4b")
    ap.add_argument("--samples", type=int, default=10)
    ap.add_argument("--temperature", type=float, default=1.0)
    args = ap.parse_args()

    base = args.base or find_port(args.api)
    if not base:
        print("No llama-server found. Start the app (or pass --base http://127.0.0.1:8791).")
        sys.exit(2)
    print(f"llama-server: {base}   model: {args.model}   samples: {args.samples}   temp: {args.temperature}\n")

    enum_tool = _tool(
        "run_workflow",
        {"workflow_id": {"type": "string", "enum": ALLOWED, "description": "Workflow to run."}},
        ["workflow_id"],
    )
    ask = f"Run workflow {DECOY}."
    in_enum = lambda r: r.get("workflow_id") in ALLOWED  # noqa: E731

    passed = []

    # 1. Positive control — one tool. If this leaks, enums are not honoured at all.
    passed.append(report(
        "1. string enum, 1 tool",
        probe(base, args.model, [enum_tool], ask, args.samples, args.temperature),
        in_enum,
        f"asked for {DECOY!r}, only {ALLOWED} are legal",
    ))

    # 2. The test that matters — a realistic list. tool_choice died exactly here.
    passed.append(report(
        "2. string enum, 14 tools",
        probe(base, args.model, [enum_tool] + _filler(13), ask, args.samples, args.temperature),
        in_enum,
        "same probe with a full-size tool list",
    ))

    # 3. Integer enums take a different json_schema_to_grammar branch.
    int_tool = _tool(
        "set_param",
        {"step": {"type": "integer", "enum": [1, 2, 3], "description": "1-based step number."}},
        ["step"],
    )
    passed.append(report(
        "3. integer enum",
        probe(base, args.model, [int_tool], "Change step 9 of the workflow.", args.samples, args.temperature),
        lambda r: r.get("step") in (1, 2, 3),
        "asked for step 9, only 1..3 are legal",
    ))

    # 4. Degenerate schemas must not 500 — this is what the `if values:` guard in
    #    _tools_for protects against.
    single = _tool("only_one", {"x": {"type": "string", "enum": ["only"]}}, ["x"])
    passed.append(report(
        "4a. single-value enum does not error",
        probe(base, args.model, [single], "Call only_one with x set to something.", 2, args.temperature),
        lambda r: "__http__" not in r,
    ))
    empty = _tool("empty_enum", {"x": {"type": "string", "enum": []}}, ["x"])
    empty_res = probe(base, args.model, [empty], "Call empty_enum.", 1, args.temperature)
    print(f"ℹ  4b. empty enum → {json.dumps(empty_res[0], ensure_ascii=False)[:160]}")
    print("    (informational: agent.py never sends one — this shows why)")

    print(f"\n{sum(passed)}/{len(passed)} checks passed")
    if all(passed):
        print("Enums are honoured. Set MODLY_AGENT_ENUMS=1 and re-run run_evals.py to measure the gain.")
    else:
        print("Enums leak. Leave MODLY_AGENT_ENUMS off; the post-hoc validation in agent.py is the defence.")
    sys.exit(0 if all(passed) else 1)


if __name__ == "__main__":
    main()
