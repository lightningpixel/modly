"""
Agent chat endpoint — runs an Ollama-powered tool-use loop against Modly's API.
"""
import json
import re
import uuid
import httpx
from fastapi import APIRouter
from pydantic import BaseModel

import services.generator_registry as reg_module

router = APIRouter(prefix="/agent", tags=["agent"])

MODLY_API = "http://localhost:8765"

SYSTEM_PROMPT = """\
You are Modly's built-in AI assistant, specialized in 3D modeling and workflow automation.
You help users generate 3D models from images, optimize meshes, and manage workflows directly inside the Modly application.

## Available tools

- **list_models** — List all downloaded 3D generation models ready to use.
- **unload_models** — Unload all 3D generation models from GPU VRAM to free memory.
- **get_mesh_info** — Get info about the current mesh in the 3D viewer (path, triangle count).
- **decimate_mesh(path, target_faces)** — Reduce the polygon count of a mesh.
- **smooth_mesh(path, iterations)** — Apply Laplacian smoothing to a mesh.
- **get_generation_status(job_id)** — Poll the status of an ongoing 3D generation job.
- **list_workflows** — List all available workflows in Modly.
- **run_workflow(workflow_id)** — Execute a workflow in Modly by its ID. If the user attached an image in their message, it will automatically be used as the workflow's input image.
- **create_workflow(name, input_type, steps, description?)** — Create a new workflow from an ordered list of processing steps. Each step references an extension by its exact `id` and may override its params. The steps run in sequence, the output of one feeding the next. The input source is one of exactly three nodes — `image` (Image), `text` (Text), or `mesh` (Load 3D Mesh) — and an Add-to-Scene output node is appended automatically.

## Rules

- Always use tools to act on the scene — never just describe what you would do.
- If you need the current mesh path, call get_mesh_info first.
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
                await client.post(f"{MODLY_API}/model/unload-all")
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
    images: list[str] = []


class AgentChatRequest(BaseModel):
    messages: list[ChatMessage]
    ollama_url: str = "http://localhost:11434"
    model: str = "qwen2.5:3b"
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


def _extract_thinking(msg: dict) -> tuple[str, str | None]:
    """Return (clean_content, thinking_text). Handles both Ollama native field and <think> tags."""
    content = msg.get("content", "")
    thinking = msg.get("thinking") or None
    if not thinking:
        match = re.search(r"<think>(.*?)</think>", content, re.DOTALL)
        if match:
            thinking = match.group(1).strip()
            content = (content[: match.start()] + content[match.end() :]).strip()
    return content, thinking


def _read_glb_modly_extras(glb_path) -> dict | None:
    """Parse a GLB's leading JSON chunk and return asset.extras.modly, if present.
    Used only as a fallback for assets that predate the .tags.json sidecar."""
    try:
        with open(glb_path, "rb") as f:
            header = f.read(12)
            if len(header) < 12 or header[0:4] != b"glTF":
                return None
            chunk_header = f.read(8)
            if len(chunk_header) < 8 or chunk_header[4:8] != b"JSON":
                return None
            chunk_length = int.from_bytes(chunk_header[0:4], "little")
            doc = json.loads(f.read(chunk_length))
            return (doc.get("asset") or {}).get("extras", {}).get("modly")
    except Exception:
        return None


def _load_asset_meta(workspace_rel_path: str) -> dict | None:
    """Resolve name/project/tags/lineage for the model currently in the viewer.

    Reads the .tags.json sidecar when present, falling back to the GLB's own
    embedded extras.modly for name/project/tags. Lineage (derived_from) is only
    ever written to the sidecar, so an asset with no sidecar has none to report.
    """
    workspace_dir = reg_module.WORKSPACE_DIR.resolve()
    abs_path = (workspace_dir / workspace_rel_path).resolve()
    if not str(abs_path).startswith(str(workspace_dir)):
        return None  # escapes the workspace — refuse to read

    sidecar_path = abs_path.with_suffix(".tags.json")
    if sidecar_path.exists():
        try:
            data = json.loads(sidecar_path.read_text(encoding="utf-8"))
            return {
                "name": data.get("name"),
                "project": data.get("project"),
                "tags": data.get("tags") or [],
                "derived_from": data.get("derived_from"),
            }
        except Exception:
            pass  # malformed sidecar — fall through to the GLB fallback

    modly = _read_glb_modly_extras(abs_path)
    if modly:
        return {
            "name": modly.get("name"),
            "project": modly.get("project"),
            "tags": modly.get("tags") or [],
            "derived_from": None,
        }
    return None


@router.get("/models")
async def list_ollama_models(ollama_url: str = "http://localhost:11434"):
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            r = await client.get(f"{ollama_url}/api/tags")
            r.raise_for_status()
            models = [m["name"] for m in r.json().get("models", [])]
            return {"models": models}
        except Exception:
            return {"models": []}


@router.post("/chat", response_model=AgentChatResponse)
async def agent_chat(request: AgentChatRequest):
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Inject scene context so the LLM knows current state
    if request.context:
        ctx_lines = []
        if request.context.get("currentMeshPath"):
            ctx_lines.append(f"Current mesh path: {request.context['currentMeshPath']}")
        if request.context.get("meshTriangles"):
            ctx_lines.append(f"Current mesh triangles: {request.context['meshTriangles']:,}")
        if request.context.get("currentClipName"):
            ctx_lines.append(f"Current animation clip: {request.context['currentClipName']}")
        if request.context.get("availableClips"):
            ctx_lines.append(f"Available animation clips: {', '.join(request.context['availableClips'])}")

        mesh_path = request.context.get("currentMeshPath")
        meta = _load_asset_meta(mesh_path) if mesh_path else None
        if meta:
            if meta.get("name"):
                ctx_lines.append(f"Model name: {meta['name']}")
            if meta.get("project"):
                ctx_lines.append(f"Project: {meta['project']}")
            if meta.get("tags"):
                ctx_lines.append(f"Tags: {', '.join(meta['tags'])}")
            derived = meta.get("derived_from")
            if derived:
                parent = derived.get("parent") or {}
                root = derived.get("root") or {}
                parent_label = parent.get("name") or parent.get("path")
                root_label = root.get("name") or root.get("path")
                if parent_label == root_label:
                    ctx_lines.append(f"Derived from: {parent_label}")
                else:
                    ctx_lines.append(f"Derived from: {parent_label} (originally: {root_label})")
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

    for m in request.messages:
        entry: dict = {"role": m.role, "content": m.content}
        if m.images:
            entry["images"] = m.images
        messages.append(entry)

    actions_done: list[ActionDone] = []
    all_thinking:  list[str]       = []

    # Build Ollama think param
    ollama_extra: dict = {}
    if request.thinking == "on":
        ollama_extra["think"] = True
    elif request.thinking == "off":
        ollama_extra["think"] = False

    async with httpx.AsyncClient(timeout=120.0) as client:
        for _ in range(10):  # max tool-call rounds
            r = await client.post(
                f"{request.ollama_url}/api/chat",
                json={"model": request.model, "messages": messages, "tools": TOOLS, "stream": False, **ollama_extra},
            )

            if r.status_code != 200:
                return AgentChatResponse(
                    message=f"Ollama error ({r.status_code}). Is Ollama running at {request.ollama_url}?",
                )

            msg = r.json()["message"]
            messages.append(msg)

            clean_content, thinking_text = _extract_thinking(msg)
            if thinking_text:
                all_thinking.append(thinking_text)

            tool_calls = msg.get("tool_calls") or []
            if not tool_calls:
                combined_thinking = "\n\n---\n\n".join(all_thinking) if all_thinking else None
                return AgentChatResponse(
                    message=clean_content,
                    actions=actions_done,
                    thinking=combined_thinking,
                )

            for tc in tool_calls:
                fn = tc["function"]
                result_text, payload = await execute_tool(fn["name"], fn.get("arguments") or {}, request.context)
                actions_done.append(ActionDone(tool=fn["name"], result=result_text, payload=payload))
                messages.append({"role": "tool", "content": result_text})

        has_workflow = any(a.tool == "run_workflow" for a in actions_done)
        if has_workflow:
            # Unload LLM from VRAM immediately so the workflow has full GPU memory
            try:
                await client.post(
                    f"{request.ollama_url}/api/generate",
                    json={"model": request.model, "keep_alive": 0},
                    timeout=5.0,
                )
            except Exception:
                pass

    combined_thinking = "\n\n---\n\n".join(all_thinking) if all_thinking else None
    return AgentChatResponse(message="Reached maximum tool iterations.", actions=actions_done, thinking=combined_thinking)
