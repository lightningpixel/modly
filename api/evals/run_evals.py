#!/usr/bin/env python3
"""On-demand eval harness for the Modly agent's tool-calling.

Runs each case in cases.json against a LIVE agent endpoint and grades the tools
it called + their results. This is how we tell whether a prompt or model change
actually improves task success, instead of eyeballing one conversation.

The Modly API must be running (or point --url at it). Cases are self-contained:
each carries its own synthetic `context` (extensions/workflows), so the score
doesn't depend on what's installed on the machine — only on the model + prompt.

A single pass of a small local model proves very little — it samples. Use
--repeat to get a per-case pass RATE, and compare rates across changes.

Usage:
    python evals/run_evals.py
    python evals/run_evals.py --model qwen3-4b --repeat 5
    python evals/run_evals.py --repeat 5 --json > baseline.json
    python evals/run_evals.py --provider external --base-url https://api.openai.com/v1 --api-key sk-... --model gpt-4o
"""
import argparse
import json
import sys
from pathlib import Path

import httpx

# Runnable both as `python evals/run_evals.py` (cwd=api) and `python -m evals.run_evals`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from evals.grader import grade  # noqa: E402
from services.api_token import local_headers  # noqa: E402

# Windows consoles default to cp1252, which can't encode the ✓/✗ marks nor
# accented case names — a crash mid-run would lose the whole score.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent


def run_case(url: str, model, provider_type: str, base_url, api_key, case: dict):
    provider: dict = {"type": provider_type}
    if base_url:
        provider["base_url"] = base_url
    if api_key:
        provider["api_key"] = api_key

    # `messages` carries a full transcript when the case needs one (a refusal the
    # model must not repeat); `user` is the shorthand for a single-turn case.
    payload: dict = {
        "messages": case.get("messages") or [{"role": "user", "content": case["user"]}],
        "provider": provider,
        "context": case.get("context", {}),
        "thinking": case.get("thinking", "off"),
    }
    if model:
        payload["model"] = model

    actions: list[dict] = []
    final = ""
    error = None
    with httpx.stream("POST", f"{url.rstrip('/')}/agent/chat", json=payload, timeout=300.0, headers=local_headers()) as r:
        for line in r.iter_lines():
            if not line.startswith("data:"):
                continue
            try:
                ev = json.loads(line[5:].strip())
            except ValueError:
                continue
            kind = ev.get("type")
            if kind == "action":
                # The payload is what the app actually applies — grading only the
                # tool name can't tell a correct mutation from a wrong one.
                actions.append({
                    "tool": ev.get("tool"),
                    "result": ev.get("result"),
                    "payload": ev.get("payload"),
                })
            elif kind == "done":
                final = ev.get("message", "")
            elif kind == "error":
                error = ev.get("message")
    return actions, final, error


def main() -> None:
    ap = argparse.ArgumentParser(description="Grade the Modly agent's tool-calling against cases.json")
    ap.add_argument("--url", default="http://localhost:8765", help="Modly API base URL")
    ap.add_argument("--model", default=None, help="model id/name (default: server default)")
    ap.add_argument("--provider", default="local", choices=["local", "external"])
    ap.add_argument("--base-url", default=None, help="external provider base URL")
    ap.add_argument("--api-key", default=None, help="external provider API key")
    ap.add_argument("--cases", default=str(HERE / "cases.json"))
    ap.add_argument("--repeat", type=int, default=1,
                    help="runs per case; the score becomes a pass RATE (small models sample)")
    ap.add_argument("--min-rate", type=float, default=None,
                    help="per-case pass rate required for exit 0 (default: 1.0)")
    ap.add_argument("--json", action="store_true", help="also print a machine-readable report to stdout")
    ap.add_argument("--only", default=None, help="substring filter on case names")
    args = ap.parse_args()

    cases = json.loads(Path(args.cases).read_text(encoding="utf-8"))
    if args.only:
        cases = [c for c in cases if args.only.lower() in c["name"].lower()]
    repeat = max(1, args.repeat)
    min_rate = args.min_rate if args.min_rate is not None else 1.0

    report = []
    for case in cases:
        runs = []
        for _ in range(repeat):
            try:
                actions, final, error = run_case(
                    args.url, args.model, args.provider, args.base_url, args.api_key, case,
                )
            except Exception as e:  # noqa: BLE001 - a failed request is a failed case, keep going
                runs.append({"ok": False, "reasons": [f"request failed: {e}"], "tools": []})
                continue
            ok, reasons = grade(case, actions, final, error)
            runs.append({
                "ok": ok,
                "reasons": reasons,
                "tools": [str(a["tool"]) for a in actions],
            })

        rate = sum(r["ok"] for r in runs) / len(runs)
        report.append({"name": case["name"], "rate": rate, "runs": runs})

        mark = "✓" if rate >= min_rate else "✗"
        score = f"{sum(r['ok'] for r in runs)}/{len(runs)}" if repeat > 1 else ""
        tools = ", ".join(runs[0]["tools"]) or "(none)"
        print(f"{mark} {case['name']} {score}  [tools: {tools}]")
        # Every distinct reason across the runs — a flaky case fails for varying
        # reasons and only seeing one of them sends you down the wrong path.
        for reason in dict.fromkeys(r for run in runs for r in run["reasons"]):
            print(f"    - {reason}")

    ok_cases = sum(1 for c in report if c["rate"] >= min_rate)
    overall = sum(c["rate"] for c in report) / len(report) if report else 0.0
    print(f"\n{ok_cases}/{len(report)} cases at rate ≥ {min_rate:.0%} — mean rate {overall:.0%}"
          f" ({repeat} run(s) per case)")

    if args.json:
        print(json.dumps({
            "model": args.model,
            "provider": args.provider,
            "repeat": repeat,
            "min_rate": min_rate,
            "mean_rate": overall,
            "cases": report,
        }, indent=2, ensure_ascii=False))

    sys.exit(0 if ok_cases == len(report) else 1)


if __name__ == "__main__":
    main()
