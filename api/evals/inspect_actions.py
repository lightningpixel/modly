#!/usr/bin/env python3
"""Look at what the agent actually built, not whether a case went green.

run_evals.py grades one expectation per case. This runs realistic requests and
then *inspects every payload the app would apply*: is the graph connected, does
each step accept what the previous one emits, are the param ids real, does the
chain end on the right sink. A workflow can satisfy a case's `payload_includes`
and still be unbuildable — that is exactly what this catches.

    python evals/inspect_actions.py                 # all scenarios, 3 runs each
    python evals/inspect_actions.py --repeat 1 --only export
    python evals/inspect_actions.py --verbose       # print every graph, not just broken ones

Exit code is the number of scenarios that produced at least one broken payload.
"""
import argparse
import json
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from services.api_token import local_headers  # noqa: E402
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent

SOURCE_NODES = {"imageNode": "image", "textNode": "text", "meshNode": "mesh"}
SINK_NODES = {"outputNode", "previewNode"}


# ── The roster the scenarios run against ─────────────────────────────────────
# The installed built-ins, with the descriptions their manifests ship, plus a
# generator so image→mesh chains are buildable.
ROSTER = [
    {"id": "trellis2/generate", "name": "Image to 3D", "type": "model",
     "input": "image", "output": "mesh",
     "description": "Generates a 3D mesh from a single image.",
     "params": ["quality", "seed"]},
    {"id": "text-to-cad/text-to-cad", "name": "Text to CAD", "type": "process",
     "input": "text", "output": "mesh",
     "description": "Generate precise parametric 3D meshes from natural-language descriptions.",
     "params": ["prompt", "model_variant", "max_retries", "output_units"]},
    {"id": "mesh-optimizer/optimize", "name": "Optimize Mesh", "type": "process",
     "input": "mesh", "output": "mesh",
     "description": "Reduces mesh triangle count using quadric simplification (meshoptimizer).",
     "params": ["target_faces"]},
    {"id": "mesh-repair/repair", "name": "Repair", "type": "process",
     "input": "mesh", "output": "mesh",
     "description": "Repairs mesh topology: removes duplicates, degenerate faces, fixes non-manifold edges, fills simple boundary holes.",
     "params": ["remove_duplicates", "remove_degenerate", "fix_non_manifold", "fill_holes", "max_hole_size"]},
    {"id": "mesh-smoother/smooth", "name": "Smooth", "type": "process",
     "input": "mesh", "output": "mesh",
     "description": "Smooths mesh vertices to reduce sharp artifacts (e.g. zipper triangles from AI-generated meshes) using Taubin smoothing.",
     "params": ["iterations", "lambda_", "mode"]},
    {"id": "mesh-exporter/export", "name": "Export Mesh", "type": "process",
     "input": "mesh", "output": "mesh",
     "description": "Exports the mesh to a chosen format (GLB, STL, OBJ, PLY) at a specified output path.",
     "params": ["export_format", "output_path"]},
]

WF_DUCK = {
    "id": "wf-duck", "name": "duck", "input_type": "image",
    "steps": [
        {"extension_id": "trellis2/generate", "params": {"quality": "high"}},
        {"extension_id": "mesh-optimizer/optimize", "params": {"target_faces": 50000}},
    ],
}

SCENARIOS = [
    ("create: lighten and export",
     "Crée un workflow qui allège ce mesh à 20000 triangles puis l'exporte en STL.", {}),
    ("create: image to textured 3D",
     "Build me a workflow that turns an image into a clean 3D model I can print.", {}),
    ("create: text to CAD to STL",
     "Fais un workflow : une pièce décrite en texte, convertie en CAD, exportée en STL.", {}),
    ("modify: add a step to an existing workflow",
     "Sur mon workflow duck, ajoute une étape de lissage avant l'optimisation.",
     {"workflows": [WF_DUCK], "activeWorkflowId": "wf-duck"}),
    ("modify: change a param",
     "On the duck workflow, set the target triangle count to 8000.",
     {"workflows": [WF_DUCK], "activeWorkflowId": "wf-duck"}),
    ("modify: rename and retune",
     "Rename the duck workflow to 'duck final' and drop it to 5000 triangles.",
     {"workflows": [WF_DUCK], "activeWorkflowId": "wf-duck"}),
]


def call(url: str, model: str, user: str, context: dict) -> list[dict]:
    payload = {"messages": [{"role": "user", "content": user}], "provider": {"type": "local"},
               "context": context, "thinking": "off", "model": model}
    actions = []
    with httpx.stream("POST", f"{url.rstrip('/')}/agent/chat", json=payload, timeout=300.0, headers=local_headers()) as r:
        for line in r.iter_lines():
            if not line.startswith("data:"):
                continue
            try:
                ev = json.loads(line[5:].strip())
            except ValueError:
                continue
            if ev.get("type") == "action" and ev.get("payload"):
                actions.append({"tool": ev.get("tool"), "payload": ev["payload"]})
            elif ev.get("type") == "done":
                actions.append({"tool": "__final__", "payload": None, "message": ev.get("message", "")})
    return actions


def check_graph(wf: dict, by_id: dict) -> list[str]:
    """Every way a created workflow can be born broken."""
    bad: list[str] = []
    nodes = wf.get("nodes") or []
    edges = wf.get("edges") or []
    if not nodes:
        return ["no nodes"]

    ids = {n.get("id") for n in nodes}
    for e in edges:
        if e.get("source") not in ids or e.get("target") not in ids:
            bad.append(f"edge {e.get('source')}→{e.get('target')} points at a node that isn't there")

    sources = [n for n in nodes if n.get("type") in SOURCE_NODES]
    if len(sources) != 1:
        bad.append(f"expected exactly 1 source node, got {len(sources)}")

    steps = [n for n in nodes if n.get("type") == "extensionNode"]
    if not steps:
        bad.append("no extension step at all")

    # Reachability: every node but the source must be fed by something.
    fed = {e.get("target") for e in edges}
    for n in nodes:
        if n.get("type") not in SOURCE_NODES and n.get("id") not in fed:
            bad.append(f"{n.get('id')} ({n.get('type')}) has no incoming edge")

    # Type flow along the declared chain.
    current = SOURCE_NODES.get(sources[0].get("type")) if len(sources) == 1 else None
    for n in steps:
        ext = by_id.get((n.get("data") or {}).get("extensionId"))
        if ext is None:
            bad.append(f"step {n.get('id')} uses unknown extension {(n.get('data') or {}).get('extensionId')!r}")
            current = None
            continue
        accepts = set(str(ext.get("input", "")).split("+")) if ext.get("input") else set()
        if current and accepts and current not in accepts:
            bad.append(f"{ext['id']} accepts {'+'.join(sorted(accepts))} but is fed {current}")
        current = ext.get("output")
        declared = set(ext.get("params") or [])
        for k in (n.get("data") or {}).get("params", {}) or {}:
            if declared and k not in declared:
                bad.append(f"{ext['id']} got param {k!r}, which it does not declare")

    sinks = [n for n in nodes if n.get("type") in SINK_NODES]
    if current == "mesh" and not sinks:
        # A mesh chain with nothing to show it lands nowhere the user can see.
        last_ext = by_id.get((steps[-1].get("data") or {}).get("extensionId")) if steps else None
        if not (last_ext or {}).get("terminal"):
            bad.append("mesh chain ends without a sink node")
    return bad


def check_update(p: dict, ctx: dict, by_id: dict) -> list[str]:
    bad: list[str] = []
    wfs = {w["id"]: w for w in ctx.get("workflows") or []}
    wf = wfs.get(p.get("workflow_id"))
    if p.get("workflow_id") and wf is None:
        bad.append(f"targets unknown workflow {p.get('workflow_id')!r}")
    for sp in p.get("set_params") or []:
        step_no = sp.get("step")
        if wf and isinstance(step_no, int) and not (1 <= step_no <= len(wf["steps"])):
            bad.append(f"step {step_no} is out of range (workflow has {len(wf['steps'])})")
            continue
        if wf and isinstance(step_no, int):
            ext = by_id.get(wf["steps"][step_no - 1]["extension_id"])
            declared = set((ext or {}).get("params") or [])
            for k in (sp.get("params") or {}):
                if declared and k not in declared:
                    bad.append(f"step {step_no} ({ext['id']}) got param {k!r}, which it does not declare")
    return bad


def describe(p: dict) -> str:
    kind = p.get("type")
    if kind == "create_workflow":
        wf = p.get("workflow") or {}
        chain = " → ".join(
            (n.get("data") or {}).get("extensionId", n.get("type"))
            for n in wf.get("nodes") or []
        )
        params = {
            (n.get("data") or {}).get("extensionId"): (n.get("data") or {}).get("params")
            for n in wf.get("nodes") or [] if n.get("type") == "extensionNode"
        }
        return f"create {p.get('name') or wf.get('name') or ''!r}: {chain}\n        params: {json.dumps(params, ensure_ascii=False)}"
    if kind == "update_workflow":
        bits = [f"update {p.get('workflow_id')}"]
        if p.get("name"):
            bits.append(f"rename→{p['name']!r}")
        for sp in p.get("set_params") or []:
            bits.append(f"step {sp.get('step')}={json.dumps(sp.get('params'), ensure_ascii=False)}")
        if p.get("steps"):
            bits.append("REPLACES the pipeline with " + " → ".join(s.get("extension_id", "?") for s in p["steps"]))
        return "; ".join(bits)
    return f"{kind}: {json.dumps(p, ensure_ascii=False)[:160]}"


def main() -> None:
    ap = argparse.ArgumentParser(description="Inspect the workflows the agent actually produces")
    ap.add_argument("--url", default="http://localhost:8765")
    ap.add_argument("--model", default="qwen3-4b")
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--only", default=None, help="substring filter on scenario names")
    ap.add_argument("--verbose", action="store_true", help="print every payload, not just broken ones")
    args = ap.parse_args()

    by_id = {e["id"]: e for e in ROSTER}
    scenarios = [s for s in SCENARIOS if not args.only or args.only.lower() in s[0].lower()]
    broken_scenarios = 0

    for name, user, extra in scenarios:
        ctx = {"extensions": ROSTER, **extra}
        print(f"\n─── {name}\n    “{user}”")
        broken_here = 0
        for run in range(max(1, args.repeat)):
            try:
                actions = call(args.url, args.model, user, ctx)
            except Exception as e:  # noqa: BLE001
                print(f"    run {run + 1}: request failed: {e}")
                broken_here += 1
                continue

            applied = [a for a in actions if a["payload"]]
            final = next((a.get("message", "") for a in actions if a["tool"] == "__final__"), "")
            if not applied:
                # The failure that reads like success: prose, nothing applied.
                claim = "" if any(w in final.lower() for w in ("n'ai rien", "nothing", "not chang", "did not")) else "  ← and the answer does not say so"
                print(f"    run {run + 1}: NOTHING APPLIED{claim}\n        final: {final[:160]}")
                broken_here += 1
                continue

            for a in applied:
                p = a["payload"]
                if p.get("type") == "create_workflow":
                    bad = check_graph(p.get("workflow") or {}, by_id)
                elif p.get("type") == "update_workflow":
                    bad = check_update(p, ctx, by_id)
                else:
                    bad = []
                mark = "✗" if bad else "✓"
                if bad or args.verbose:
                    print(f"    run {run + 1} {mark} {describe(p)}")
                    for b in bad:
                        print(f"        ! {b}")
                if bad:
                    broken_here += 1
        if not broken_here and not args.verbose:
            print(f"    {args.repeat} run(s): all payloads structurally sound")
        if broken_here:
            broken_scenarios += 1

    print(f"\n{broken_scenarios}/{len(scenarios)} scenarios produced at least one broken or empty result")
    sys.exit(broken_scenarios)


if __name__ == "__main__":
    main()
