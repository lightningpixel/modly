"""
Agent chat endpoint — runs a tool-use loop against Modly's API, on the managed
local llama.cpp server or any OpenAI-compatible provider.
"""
import asyncio
import json
import uuid
from typing import Optional

import httpx
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from services import llm_server
from services.llm_server import llama_pool

router = APIRouter(prefix="/agent", tags=["agent"])

MODLY_API = "http://localhost:8765"

SYSTEM_PROMPT = """\
You are Modly's built-in AI assistant, specialized in 3D modeling and workflow automation.
You help users generate 3D models from images, optimize meshes, and manage workflows directly inside the Modly application.

## Available tools

- **list_models** — List all downloaded 3D generation models ready to use.
- **unload_models** — Unload all 3D generation models from GPU VRAM to free memory.
- **get_mesh_info** — Get info about the current mesh in the 3D viewer (path, triangle count).
- **inspect_mesh(path)** — Diagnose a mesh without modifying it: watertight, manifold, holes, self-intersections, parts, dimensions, volume, UVs/normals, and whether it is 3D-printable.
- **suggest_fixes(path)** — Inspect a mesh and list the operations (with params) that would fix its problems.
- **repair_mesh(path, fill_holes?)** — Repair a mesh automatically: fills holes, fixes non-manifold edges, degenerate faces and flipped normals, re-checking until it is closed and manifold. Writes a new, untextured mesh.
- **arrange_mesh(path, steps, size?, unit?, dimension?)** — Reposition a mesh in one call. Steps: `auto_orient` (lay it flat on its widest side), `normalize_scale` (resize to `size` in `unit`), `recenter` (centre on the origin), `drop_to_ground` (rest it on the ground). Steps always run in that order, whatever order you list them in.
- **decimate_mesh(path, target_faces)** — Reduce the polygon count of a mesh.
- **smooth_mesh(path, iterations)** — Apply Laplacian smoothing to a mesh.
- **get_generation_status(job_id)** — Poll the status of an ongoing 3D generation job.
- **list_workflows** — List all available workflows in Modly.
- **run_workflow(workflow_id)** — Execute a workflow in Modly by its ID. If the user attached an image in their message, it will automatically be used as the workflow's input image.
- **create_workflow(name, input_type, steps, description?)** — Create a new workflow from an ordered list of processing steps. Each step references an extension by its exact `id` and may override its params. The steps run in sequence, the output of one feeding the next. The input source is one of exactly three nodes — `image` (Image), `text` (Text), or `mesh` (Load 3D Mesh) — and an Add-to-Scene output node is appended automatically.

## Rules

- Always use tools to act on the scene — never just describe what you would do.
- If you need the current mesh path, call get_mesh_info first.
- To repair or fix a mesh, call repair_mesh. Report the issues it could not fix, and warn the user when it says the textures were dropped.
- To center, ground, lay flat or resize a mesh, call arrange_mesh ONCE with every requested step — never one call per step.
- To answer questions about a mesh's quality or printability, call inspect_mesh — never guess. Before repairing a mesh, call suggest_fixes to pick the right operations.
- If you need to run a workflow but don't know the ID, call list_workflows first.
- To create a workflow, ONLY use extension ids listed under "Available extensions" in the context. Never invent an id. Chain steps so each step's input type matches the previous step's output type.
- For a workflow's input, `input_type` MUST be exactly one of: `image`, `text`, or `mesh`. These map to the Image, Text, and Load 3D Mesh nodes. Never invent another input. Pick the one matching the first step's expected input.
- After each tool call, give a short one-sentence summary of what was done.
- Always reply in the same language the user is writing in.
- Be concise. No unnecessary explanations.\
"""

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "list_models",
            "description": "List all available 3D generation models that are downloaded and ready.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "unload_models",
            "description": "Unload all 3D generation models from VRAM to free GPU memory.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_mesh_info",
            "description": "Get information about the current mesh loaded in the 3D viewer (triangle count, path, etc.).",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "inspect_mesh",
            "description": "Diagnose a mesh without modifying it: watertight, manifold, holes, self-intersections, disconnected parts, dimensions, volume, UVs/normals, and whether it is 3D-printable.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative path to the mesh file. Use get_mesh_info to obtain it.",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "suggest_fixes",
            "description": "Inspect a mesh and list the operations (with parameters) that would fix its problems. Does not modify the mesh.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative path to the mesh file. Use get_mesh_info to obtain it.",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "repair_mesh",
            "description": (
                "Repair a mesh automatically: fill holes, fix non-manifold edges, degenerate "
                "faces and flipped normals, re-checking until it is closed and manifold. "
                "Writes a new mesh without textures; does nothing if the mesh is already sound."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative path to the mesh file. Use get_mesh_info to obtain it.",
                    },
                    "fill_holes": {
                        "type": "boolean",
                        "description": (
                            "Close holes (default true). Set false only for meshes meant to stay open, "
                            "like terrain: then only flipped faces are fixed."
                        ),
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "arrange_mesh",
            "description": (
                "Reposition a mesh in a single call: lay it flat, resize it, centre it and/or "
                "rest it on the ground. Pass every requested step at once; they always run in "
                "the order auto_orient → normalize_scale → recenter → drop_to_ground."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative path to the mesh file. Use get_mesh_info to obtain it.",
                    },
                    "steps": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": ["auto_orient", "normalize_scale", "recenter", "drop_to_ground"],
                        },
                        "description": (
                            "auto_orient: lay flat on its widest side (a standing figure is laid down). "
                            "normalize_scale: resize to `size`. recenter: centre on the origin. "
                            "drop_to_ground: lowest point at height 0."
                        ),
                    },
                    "size": {
                        "type": "number",
                        "description": "normalize_scale only: target size of `dimension`, in `unit`.",
                    },
                    "unit": {
                        "type": "string",
                        "enum": ["m", "cm", "mm"],
                        "description": "normalize_scale only: unit of `size`. Default m.",
                    },
                    "dimension": {
                        "type": "string",
                        "enum": ["longest", "x", "y", "z"],
                        "description": "normalize_scale only: which side gets `size` (y is the height). Default longest.",
                    },
                },
                "required": ["path", "steps"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "decimate_mesh",
            "description": "Reduce the polygon count of the current mesh using quadric edge collapse.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative path to the mesh file (e.g. 'Default/mesh.glb'). Use get_mesh_info to obtain it.",
                    },
                    "target_faces": {
                        "type": "integer",
                        "description": "Target number of faces after decimation.",
                    },
                },
                "required": ["path", "target_faces"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "smooth_mesh",
            "description": "Apply Laplacian smoothing to the current mesh.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative path to the mesh file. Use get_mesh_info to obtain it.",
                    },
                    "iterations": {
                        "type": "integer",
                        "description": "Number of smoothing iterations (1–20). More = smoother but loses detail.",
                    },
                },
                "required": ["path", "iterations"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_generation_status",
            "description": "Poll the status of an ongoing 3D generation job.",
            "parameters": {
                "type": "object",
                "properties": {
                    "job_id": {"type": "string", "description": "Job ID returned by a previous generation call."},
                },
                "required": ["job_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_workflows",
            "description": "List all workflows available in Modly.",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_workflow",
            "description": "Execute a Modly workflow by its ID. The workflow runs in the background; progress is shown in the app.",
            "parameters": {
                "type": "object",
                "properties": {
                    "workflow_id": {"type": "string", "description": "The workflow ID to execute. Use list_workflows to get available IDs."},
                },
                "required": ["workflow_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "create_workflow",
            "description": (
                "Create a new Modly workflow from an ordered list of steps. "
                "Each step references an extension by its exact id (see 'Available extensions' in context). "
                "Steps run in sequence; do not include the input itself as a step."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Short human-readable name for the workflow."},
                    "description": {"type": "string", "description": "Optional one-line description of what the workflow does."},
                    "input_type": {
                        "type": "string",
                        "enum": ["image", "text", "mesh"],
                        "description": (
                            "The workflow's input source node. Exactly one of: "
                            "'image' (Image node), 'text' (Text node), "
                            "'mesh' (Load 3D Mesh node, uses the current scene mesh). "
                            "Never use any other value."
                        ),
                    },
                    "steps": {
                        "type": "array",
                        "description": "Ordered processing steps. Each runs after the previous one.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "extension_id": {
                                    "type": "string",
                                    "description": "Exact extension id from 'Available extensions' (e.g. 'mesh-optimizer/optimize').",
                                },
                                "params": {
                                    "type": "object",
                                    "description": "Optional param overrides, keyed by param id. Omit to use defaults.",
                                },
                            },
                            "required": ["extension_id"],
                        },
                    },
                },
                "required": ["name", "input_type", "steps"],
            },
        },
    },
]


# Input kinds the agent may pick, mapped to the real Modly source-node types.
# Keep this in sync with the node palette in WorkflowsPage.tsx.
INPUT_NODES = {
    "image": {"type": "imageNode", "data": {"enabled": True, "params": {}, "showInGenerate": True}},
    "text":  {"type": "textNode",  "data": {"enabled": True, "params": {}}},
    "mesh":  {"type": "meshNode",  "data": {"enabled": True, "params": {"source": "current"}}},
}


def _build_workflow_graph(name: str, description: str, input_type: str, steps: list[dict]) -> dict:
    """Assemble a Modly workflow graph (nodes + edges) from a simplified step spec.

    Layout: one source node (Image / Text / Load 3D Mesh), one extensionNode per
    step, then an Add-to-Scene output node, all wired in a single linear chain with
    workflowEdge edges. id/timestamps are left for the frontend to stamp
    (crypto.randomUUID + ISO date), matching how the Workflows tab creates workflows.
    """
    spec = INPUT_NODES.get(input_type, INPUT_NODES["image"])
    input_node = {
        "id": uuid.uuid4().hex[:8],
        "type": spec["type"],
        "position": {"x": 250, "y": 50},
        "data": {**spec["data"]},
    }

    ext_nodes = []
    for i, step in enumerate(steps):
        ext_nodes.append({
            "id": uuid.uuid4().hex[:8],
            "type": "extensionNode",
            "position": {"x": 250, "y": 150 + i * 200},
            "data": {
                "extensionId": step["extension_id"],
                "enabled": True,
                "params": step.get("params") or {},
            },
        })

    output_node = {
        "id": uuid.uuid4().hex[:8],
        "type": "outputNode",
        "position": {"x": 250, "y": 150 + len(steps) * 200},
        "data": {"enabled": True, "params": {}},
    }

    all_nodes = [input_node, *ext_nodes, output_node]
    edges = [
        {
            "id": f"e-{all_nodes[i]['id']}-{all_nodes[i + 1]['id']}",
            "source": all_nodes[i]["id"],
            "target": all_nodes[i + 1]["id"],
            "type": "workflowEdge",
        }
        for i in range(len(all_nodes) - 1)
    ]

    return {"name": name, "description": description, "nodes": all_nodes, "edges": edges}


def _format_inspection(report: dict) -> str:
    """Render an inspect_mesh report as compact text for the model."""
    def yes_no(value) -> str:
        return "unknown" if value is None else ("yes" if value else "no")

    dims = " × ".join(f"{d:.4g}" for d in report.get("dimensions", []))
    volume = report.get("volume")
    self_hits = report.get("self_intersecting_face_count")
    lines = [
        f"Printable: {yes_no(report.get('printable'))}",
        f"Faces: {report.get('face_count', '?'):,}, vertices: {report.get('vertex_count', '?'):,}, parts: {report.get('component_count', '?')}",
        f"Watertight: {yes_no(report.get('is_watertight'))}, manifold: {yes_no(report.get('is_manifold'))}, consistent winding: {yes_no(report.get('is_winding_consistent'))}",
        f"Holes: {report.get('hole_count', 0)} ({report.get('boundary_edge_count', 0)} open edges), non-manifold edges: {report.get('non_manifold_edge_count', 0)}, degenerate faces: {report.get('degenerate_face_count', 0)}",
        f"Self-intersecting faces: {'not checked' if self_hits is None else self_hits}",
        f"Dimensions: {dims}, surface area: {report.get('surface_area', 0):.4g}, volume: {'n/a (not closed)' if volume is None else f'{volume:.4g}'}",
        f"UVs: {yes_no(report.get('has_uvs'))}, normals: {yes_no(report.get('has_normals'))}",
    ]
    issues = report.get("issues") or []
    if issues:
        lines.append("Issues: " + "; ".join(issues))
    return "\n".join(lines)


def _format_fixes(data: dict) -> str:
    """Render a suggest_fixes result as compact text for the model."""
    fixes = data.get("fixes") or []
    notes = data.get("notes") or []
    if not fixes and not notes:
        return "No fixes needed — the mesh has no detected problems."
    lines = ["Suggested operations:"] if fixes else ["No operation can fix the detected problems."]
    for fix in fixes:
        lines.append(f"- {fix['op']} {json.dumps(fix.get('params', {}))}: {fix.get('reason', '')}")
    lines.extend(f"Note: {note}" for note in notes)
    return "\n".join(lines)


def _format_repair(data: dict) -> tuple[str, dict | None]:
    """Render a repair_mesh result for the model, plus the viewer update."""
    remaining = data.get("remaining_issues") or []
    if not data.get("repaired"):
        text = "Nothing to repair: the mesh is already closed and manifold."
        if remaining:
            text = "Nothing was repaired. Remaining: " + "; ".join(remaining) + "."
        return text, None

    steps = ", ".join(data.get("steps") or [])
    lines = [
        f"Repaired in {data.get('passes', '?')} pass(es) ({steps}).",
        ("Still remaining: " + "; ".join(remaining) + ".") if remaining
        else "The mesh is now closed (watertight) and manifold.",
        f"New mesh path: {data['path']} ({data.get('face_count', '?'):,} faces).",
    ]
    if data.get("textures_dropped"):
        lines.append("The textures and UVs were dropped: the repaired mesh is geometry only.")
    payload = {"type": "mesh_update", "url": data["url"], "face_count": data.get("face_count")}
    return "\n".join(lines), payload


async def execute_tool(name: str, arguments: dict, context: dict) -> tuple[str, dict | None]:
    """Execute a tool and return (result_text, action_payload).
    action_payload carries data the frontend needs to react (e.g. new mesh URL).
    """
    async with httpx.AsyncClient(timeout=60.0) as client:
        try:
            if name == "list_models":
                r = await client.get(f"{MODLY_API}/model/all")
                r.raise_for_status()
                models = [m for m in r.json() if m.get("downloaded")]
                if not models:
                    return "No models downloaded yet.", None
                lines = "\n".join(f"- {m['id']}: {m.get('name', m['id'])}" for m in models)
                return f"Available models:\n{lines}", None

            elif name == "unload_models":
                r = await client.post(f"{MODLY_API}/model/unload-all")
                r.raise_for_status()
                return "All 3D generation models have been unloaded from VRAM.", None

            elif name == "get_mesh_info":
                mesh_path = context.get("currentMeshPath")
                mesh_triangles = context.get("meshTriangles")
                if not mesh_path:
                    return "No mesh currently loaded in the viewer.", None
                info = f"Current mesh: {mesh_path}"
                if mesh_triangles:
                    info += f" ({mesh_triangles:,} triangles)"
                return info, None

            elif name == "inspect_mesh":
                r = await client.post(
                    f"{MODLY_API}/optimize/op/inspect_mesh",
                    json={"path": arguments["path"]},
                )
                r.raise_for_status()
                return _format_inspection(r.json()), None

            elif name == "suggest_fixes":
                r = await client.post(
                    f"{MODLY_API}/optimize/op/suggest_fixes",
                    json={"path": arguments["path"]},
                )
                r.raise_for_status()
                return _format_fixes(r.json()), None

            elif name == "repair_mesh":
                params = {}
                if arguments.get("fill_holes") is not None:
                    params["fill_holes"] = bool(arguments["fill_holes"])
                r = await client.post(
                    f"{MODLY_API}/optimize/op/repair_mesh",
                    json={"path": arguments["path"], "params": params},
                )
                r.raise_for_status()
                return _format_repair(r.json())

            elif name == "arrange_mesh":
                scale_params = {
                    key: arguments[key] for key in ("size", "unit", "dimension")
                    if arguments.get(key) is not None
                }
                r = await client.post(
                    f"{MODLY_API}/optimize/arrange",
                    json={
                        "path": arguments["path"],
                        "steps": arguments.get("steps") or [],
                        "params": {"normalize_scale": scale_params} if scale_params else {},
                    },
                )
                r.raise_for_status()
                data = r.json()
                dims = " × ".join(f"{d:.4g}" for d in data.get("dimensions", []))
                text = (
                    f"Applied {' → '.join(data.get('applied', []))}. "
                    f"New mesh path: {data['path']}. Dimensions (x × y × z, metres): {dims}."
                )
                return text, {"type": "mesh_update", "url": data["url"]}

            elif name == "decimate_mesh":
                r = await client.post(
                    f"{MODLY_API}/optimize/mesh",
                    json={"path": arguments["path"], "target_faces": arguments["target_faces"]},
                )
                r.raise_for_status()
                data = r.json()
                payload = {"type": "mesh_update", "url": data["url"], "face_count": data.get("face_count")}
                return f"Decimated to {data.get('face_count', '?')} faces.", payload

            elif name == "smooth_mesh":
                r = await client.post(
                    f"{MODLY_API}/optimize/smooth",
                    json={"path": arguments["path"], "iterations": arguments["iterations"]},
                )
                r.raise_for_status()
                data = r.json()
                payload = {"type": "mesh_update", "url": data["url"]}
                return f"Smoothed mesh ({arguments['iterations']} iterations).", payload

            elif name == "get_generation_status":
                r = await client.get(f"{MODLY_API}/generate/status/{arguments['job_id']}")
                r.raise_for_status()
                s = r.json()
                text = f"Status: {s['status']}, Progress: {s.get('progress', 0)}%"
                if s.get("step"):
                    text += f", Step: {s['step']}"
                if s.get("output_url"):
                    text += f", Output: {s['output_url']}"
                return text, None

            elif name == "list_workflows":
                workflows = context.get("workflows", [])
                if not workflows:
                    return "No workflows found. Create one in the Workflows tab.", None
                lines = "\n".join(f"- {w['id']}: {w['name']}" for w in workflows)
                return f"Available workflows:\n{lines}", None

            elif name == "run_workflow":
                workflow_id = arguments["workflow_id"]
                workflows = context.get("workflows", [])
                match = next((w for w in workflows if w["id"] == workflow_id), None)
                if not match:
                    return f"Workflow '{workflow_id}' not found. Use list_workflows to see available workflows.", None
                payload = {"type": "run_workflow", "workflow_id": workflow_id, "workflow_name": match["name"]}
                return f"Executing workflow '{match['name']}'…", payload

            elif name == "create_workflow":
                steps = arguments.get("steps") or []
                if not steps:
                    return "A workflow needs at least one step. Specify the extensions to chain.", None

                input_type = arguments.get("input_type") or "image"
                if input_type not in INPUT_NODES:
                    return (
                        f"Invalid input_type '{input_type}'. Use exactly one of: "
                        f"image (Image node), text (Text node), mesh (Load 3D Mesh node).",
                        None,
                    )

                extensions = context.get("extensions", [])
                valid_ids = {e["id"] for e in extensions}
                if valid_ids:
                    unknown = [s.get("extension_id") for s in steps if s.get("extension_id") not in valid_ids]
                    if unknown:
                        avail = ", ".join(sorted(valid_ids)) or "(none installed)"
                        return (
                            f"Unknown extension id(s): {', '.join(map(str, unknown))}. "
                            f"Use only these: {avail}.",
                            None,
                        )

                wf = _build_workflow_graph(
                    name=arguments.get("name") or "New Workflow",
                    description=arguments.get("description") or "",
                    input_type=input_type,
                    steps=steps,
                )
                payload = {"type": "create_workflow", "workflow": wf}
                return f"Created workflow '{wf['name']}' with {len(steps)} step(s).", payload

            else:
                return f"Unknown tool: {name}", None

        except httpx.HTTPStatusError as e:
            return f"API error {e.response.status_code}: {e.response.text[:200]}", None
        except Exception as e:
            return f"Error: {e}", None


class ChatMessage(BaseModel):
    role: str
    content: str
    images: list[str] = []  # data URLs


class ProviderConfig(BaseModel):
    type: str = "local"            # "local" | "external"
    base_url: Optional[str] = None  # external only, e.g. https://api.openai.com/v1
    api_key: Optional[str] = None


class AgentChatRequest(BaseModel):
    messages: list[ChatMessage]
    model: str = Field(default_factory=llm_server.default_model_id)  # local: catalog/custom id — external: provider model name
    provider: ProviderConfig = ProviderConfig()
    context: dict = {}
    thinking: str = "auto"  # "auto" | "on" | "off"


class ActionDone(BaseModel):
    tool: str
    result: str
    payload: dict | None = None


class AgentChatResponse(BaseModel):
    message: str
    actions: list[ActionDone] = []
    thinking: str | None = None


def _auth_headers(base_url: str, api_key: Optional[str]) -> dict:
    headers: dict[str, str] = {}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
        if "anthropic" in base_url:
            # Anthropic's OpenAI-compat layer also accepts the native headers.
            headers["x-api-key"] = api_key
            headers["anthropic-version"] = "2023-06-01"
    return headers


class ExternalModelsRequest(BaseModel):
    base_url: str
    api_key: str = ""


@router.post("/external/models")
async def list_external_models(req: ExternalModelsRequest):
    """Proxy the provider's /models listing (avoids CORS issues from the renderer).

    POST with the key in the body, never a GET query string: uvicorn's access log
    records the full request line, and that log ends up in runtime.log.
    """
    headers = _auth_headers(req.base_url, req.api_key)
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            r = await client.get(f"{req.base_url.rstrip('/')}/models", headers=headers)
            r.raise_for_status()
            data = r.json().get("data", [])
            return {"models": sorted(m["id"] for m in data if isinstance(m, dict) and m.get("id"))}
        except Exception:
            return {"models": []}


async def _unload_llm_after_workflow(request: AgentChatRequest, actions_done: list[ActionDone]) -> None:
    """Free the local LLM's VRAM once a workflow has been dispatched, so the
    workflow gets the full GPU. Best-effort — never fail the chat over it."""
    if request.provider.type != "local":
        return
    if not any(a.tool == "run_workflow" for a in actions_done):
        return
    try:
        await asyncio.to_thread(llama_pool.unload_all)
    except Exception:
        pass


def _error_detail(r: httpx.Response) -> str:
    """The provider's own message (OpenAI-style `{"error": {"message": …}}`), else the raw body."""
    try:
        err = r.json().get("error")
        if isinstance(err, dict) and err.get("message"):
            return str(err["message"])[:300]
        if isinstance(err, str):
            return err[:300]
    except (ValueError, AttributeError):
        pass
    return r.text[:300]


def _tool_arguments(raw) -> dict:
    """OpenAI-compatible servers send tool arguments as a JSON string."""
    if isinstance(raw, dict):
        return raw
    try:
        parsed = json.loads(raw or "{}")
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _user_entry(m: ChatMessage, send_images: bool) -> dict:
    if not (m.images and send_images):
        return {"role": m.role, "content": m.content}
    parts: list[dict] = [{"type": "text", "text": m.content}]
    for data_url in m.images:
        parts.append({"type": "image_url", "image_url": {"url": data_url}})
    return {"role": m.role, "content": parts}


def _drop_images(messages: list[dict]) -> bool:
    """Replace image parts with a text note, in place. True if any were dropped."""
    dropped = False
    for m in messages:
        if not isinstance(m.get("content"), list):
            continue
        texts = [p["text"] for p in m["content"] if p.get("type") == "text"]
        if any(p.get("type") == "image_url" for p in m["content"]):
            dropped = True
            texts.append("[An image was attached, but this model reads text only.]")
        m["content"] = "\n".join(texts)
    return dropped


class _ThinkSplitter:
    """Route inline <think>…</think> text to the reasoning, the rest to the
    answer, holding back a tag a chunk boundary has cut in two."""

    _OPEN, _CLOSE = "<think>", "</think>"

    def __init__(self) -> None:
        self._buffer = ""
        self._inside = False

    def _held(self, *tags: str) -> int:
        """Length of the buffer's tail that may be the start of a tag."""
        return max(
            next((n for n in range(len(tag) - 1, 0, -1) if self._buffer.endswith(tag[:n])), 0)
            for tag in tags
        )

    def _cut(self, index: int, tag: str, kind: str, parts: list) -> None:
        if index:
            parts.append((kind, self._buffer[:index]))
        self._buffer = self._buffer[index + len(tag):]

    def feed(self, text: str) -> list[tuple[str, str]]:
        self._buffer += text
        parts: list[tuple[str, str]] = []
        while self._buffer:
            close_at = self._buffer.find(self._CLOSE)
            if self._inside:
                if close_at >= 0:
                    self._cut(close_at, self._CLOSE, "thinking", parts)
                    self._inside = False
                    continue
                keep = self._held(self._CLOSE)
                kind = "thinking"
            else:
                open_at = self._buffer.find(self._OPEN)
                if close_at >= 0 and (open_at < 0 or close_at < open_at):
                    # A chat template that opens <think> in the prompt leaves the
                    # model only the closing tag: what came before it was reasoning.
                    self._cut(close_at, self._CLOSE, "thinking", parts)
                    continue
                if open_at >= 0:
                    self._cut(open_at, self._OPEN, "token", parts)
                    self._inside = True
                    continue
                keep = self._held(self._OPEN, self._CLOSE)
                kind = "token"
            if len(self._buffer) > keep:
                parts.append((kind, self._buffer[: len(self._buffer) - keep]))
                self._buffer = self._buffer[len(self._buffer) - keep:]
            break
        return parts

    def flush(self) -> list[tuple[str, str]]:
        rest, self._buffer = self._buffer, ""
        return [("thinking" if self._inside else "token", rest)] if rest else []


class _Round:
    """One LLM call of the tool loop, assembled from its streamed deltas."""

    def __init__(self, answered_before: bool, thought_before: bool) -> None:
        self.raw = ""  # content as the model sent it, <think> tags included
        self.answer = ""
        self.thinking = ""
        self.tool_calls: dict[int, dict] = {}
        self._splitter = _ThinkSplitter()
        self._answered_before = answered_before
        self._thought_before = thought_before

    def _text(self, kind: str, text: str) -> dict | None:
        # Each round's text is stripped at its start, as the non-streamed
        # answer was, and set apart from what earlier rounds already showed.
        if kind == "token":
            if not self.answer:
                text = text.lstrip()
                if not text:
                    return None
                self.answer = text
                return {"type": "token", "text": ("\n\n" if self._answered_before else "") + text}
            self.answer += text
            return {"type": "token", "text": text}
        if not self.thinking:
            text = text.lstrip()
            if not text:
                return None
            self.thinking = text
            return {"type": "thinking", "text": ("\n\n---\n\n" if self._thought_before else "") + text}
        self.thinking += text
        return {"type": "thinking", "text": text}

    def apply(self, delta: dict) -> list[dict]:
        events = []
        # llama-server sends reasoning_content; Ollama and OpenRouter, reasoning.
        reasoning = delta.get("reasoning_content") or delta.get("reasoning")
        if isinstance(reasoning, str) and reasoning:
            events.append(self._text("thinking", reasoning))
        content = delta.get("content")
        if isinstance(content, str) and content:
            self.raw += content
            events.extend(self._text(kind, text) for kind, text in self._splitter.feed(content))
        for position, fragment in enumerate(delta.get("tool_calls") or []):
            # Streamed tool calls arrive in fragments keyed by index: the id and
            # name come first, the JSON arguments in pieces after them.
            call = self.tool_calls.setdefault(
                fragment.get("index", position),
                {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
            )
            call["id"] = fragment.get("id") or call["id"]
            function = fragment.get("function") or {}
            call["function"]["name"] += function.get("name") or ""
            arguments = function.get("arguments")
            if isinstance(arguments, dict):
                arguments = json.dumps(arguments)
            call["function"]["arguments"] += arguments or ""
        return [e for e in events if e]

    def finish(self) -> list[dict]:
        return [e for e in (self._text(k, t) for k, t in self._splitter.flush()) if e]

    def calls(self) -> list[dict]:
        calls = [self.tool_calls[i] for i in sorted(self.tool_calls)]
        for call in calls:
            # The tool result must answer the call's id; a few servers omit it.
            call["id"] = call["id"] or f"call_{uuid.uuid4().hex[:8]}"
        return calls


async def _read_round(response: httpx.Response, round_: _Round):
    """Yield the answer and reasoning of one LLM call as they stream in."""
    if "text/event-stream" not in response.headers.get("content-type", ""):
        # A server that ignored "stream": true answers in one JSON body.
        message = json.loads(await response.aread())["choices"][0]["message"]
        for event in round_.apply(message):
            yield event
    else:
        async for line in response.aiter_lines():
            if not line.startswith("data:"):
                continue
            data = line[len("data:"):].strip()
            if data == "[DONE]":
                break
            try:
                choices = json.loads(data).get("choices") or []
            except ValueError:
                continue
            if choices:
                for event in round_.apply(choices[0].get("delta") or {}):
                    yield event
    for event in round_.finish():
        yield event


def _done(message: str, actions: list[ActionDone], thinking: list[str], error: bool = False) -> dict:
    return {
        "type": "done",
        "message": message,
        "actions": [a.model_dump() for a in actions],
        "thinking": "\n\n---\n\n".join(thinking) if thinking else None,
        # The message reports a failure rather than answering: the chat shows
        # it after whatever text already streamed.
        "error": error,
    }


def _release_claimed(claim: asyncio.Future) -> None:
    if not claim.cancelled() and claim.exception() is None:
        claim.result().release()


async def _claim_slot(model: str, spec: dict):
    """Hold a local LLM slot, without leaking it if the caller is cancelled.

    A streamed chat is cancelled when its client leaves, possibly while the
    model is still loading. The loading thread can't be stopped and claims the
    slot anyway; nobody would release it, and a held slot is never reaped.
    """
    claim = asyncio.ensure_future(asyncio.to_thread(llama_pool.ensure, model, spec, True))
    try:
        return await asyncio.shield(claim)
    except asyncio.CancelledError:
        claim.add_done_callback(_release_claimed)
        raise


async def _chat_events(request: AgentChatRequest):
    """Run the tool loop, yielding its events as they happen.

    token / thinking — answer and reasoning text, in pieces
    tool_start / tool_done — around each tool call
    done — always last: the final answer, every action and the full reasoning
    """
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Inject scene context so the LLM knows current state
    if request.context:
        ctx_lines = []
        if request.context.get("currentMeshPath"):
            ctx_lines.append(f"Current mesh path: {request.context['currentMeshPath']}")
        if request.context.get("meshTriangles"):
            ctx_lines.append(f"Current mesh triangles: {request.context['meshTriangles']:,}")
        if ctx_lines:
            messages.append({
                "role": "system",
                "content": "Scene context:\n" + "\n".join(ctx_lines),
            })

        extensions = request.context.get("extensions") or []
        if extensions:
            ext_lines = [
                f"- {e['id']} ({e.get('input', '?')}→{e.get('output', '?')}): {e.get('name', e['id'])}"
                for e in extensions
            ]
            messages.append({
                "role": "system",
                "content": (
                    "Available extensions (use the exact id when creating workflows):\n"
                    + "\n".join(ext_lines)
                ),
            })

    # ONE system message, first. Qwen3.5's chat template raises "System message
    # must be at the beginning", which llama-server returns as a flat HTTP 400;
    # other templates silently drop the extra ones.
    messages = [{"role": "system", "content": "\n\n".join(m["content"] for m in messages)}]

    slot = None
    send_images = True
    extra: dict = {}
    if request.provider.type == "local":
        try:
            spec = llm_server.resolve_model(request.model)
            # hold=True: the slot stays claimed for the whole loop, so neither the
            # idle reaper nor a model loading elsewhere can evict it mid-answer.
            slot = await _claim_slot(request.model, spec)
        except Exception as e:
            yield _done(f"Could not start the local LLM: {e}", [], [], error=True)
            return
        base_url = slot.base_url
        headers: dict = {}
        send_images = spec["vision"]
        extra.update(llm_server.sampling_for(request.model))
        if request.thinking == "off":
            extra["chat_template_kwargs"] = {"enable_thinking": False}
    else:
        if not request.provider.base_url:
            yield _done("No provider URL configured. Set one in Settings → Agent.", [], [], error=True)
            return
        base_url = request.provider.base_url.rstrip("/")
        headers = _auth_headers(base_url, request.provider.api_key)

    for m in request.messages:
        messages.append(_user_entry(m, send_images))

    actions_done: list[ActionDone] = []
    all_thinking:  list[str]       = []
    final: str | None = None
    error: str | None = None
    answered = False

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:

            async def post() -> httpx.Response:
                return await client.send(
                    client.build_request(
                        "POST",
                        f"{base_url}/chat/completions",
                        headers=headers,
                        json={"model": request.model, "messages": messages, "tools": TOOLS, "stream": True, **extra},
                    ),
                    stream=True,
                )

            for _ in range(10):  # max tool-call rounds
                round_ = _Round(answered, bool(all_thinking))
                r = await post()
                try:
                    # An external model's vision support is unknown up front, and a
                    # text-only one rejects image parts with a 400 that failed the
                    # whole turn. Retry once with the images described as omitted.
                    if r.status_code == 400 and request.provider.type != "local" and _drop_images(messages):
                        await r.aclose()
                        r = await post()

                    if r.status_code != 200:
                        await r.aread()
                        error = f"LLM error ({r.status_code}): {_error_detail(r)}"
                        break

                    async for event in _read_round(r, round_):
                        yield event
                finally:
                    await r.aclose()

                answered = answered or bool(round_.answer)
                if round_.thinking:
                    all_thinking.append(round_.thinking)
                tool_calls = round_.calls()
                assistant: dict = {"role": "assistant", "content": round_.raw}
                if tool_calls:
                    assistant["tool_calls"] = tool_calls
                messages.append(assistant)

                if not tool_calls:
                    final = round_.answer.strip()
                    break

                for tc in tool_calls:
                    fn = tc["function"]
                    arguments = _tool_arguments(fn.get("arguments"))
                    yield {"type": "tool_start", "id": tc["id"], "tool": fn["name"], "arguments": arguments}
                    result_text, payload = await execute_tool(fn["name"], arguments, request.context)
                    actions_done.append(ActionDone(tool=fn["name"], result=result_text, payload=payload))
                    yield {"type": "tool_done", "id": tc["id"], "tool": fn["name"], "result": result_text, "payload": payload}
                    messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result_text})
    except httpx.HTTPError as e:
        error = f"Could not reach the LLM at {base_url}: {e}"
    finally:
        # Also runs when the client disconnects mid-answer.
        if slot is not None:
            slot.release()

    # After the release: unload_all() spares a held slot, so unloading while
    # still holding ours would keep the agent's own model on the GPU.
    await _unload_llm_after_workflow(request, actions_done)

    if error is not None:
        yield _done(error, actions_done, all_thinking, error=True)
    elif final is None:
        yield _done("Reached maximum tool iterations.", actions_done, all_thinking, error=True)
    else:
        yield _done(final, actions_done, all_thinking)


@router.post("/chat", response_model=AgentChatResponse)
async def agent_chat(request: AgentChatRequest):
    """The whole turn at once, for callers that don't read a stream."""
    done: dict = {}
    async for event in _chat_events(request):
        if event["type"] == "done":
            done = event
    return AgentChatResponse(message=done["message"], actions=done["actions"], thinking=done["thinking"])


@router.post("/chat/stream")
async def agent_chat_stream(request: AgentChatRequest):
    """The same turn as Server-Sent Events, one JSON event per `data:` line."""

    async def body():
        async for event in _chat_events(request):
            yield f"data: {json.dumps(event)}\n\n"

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
