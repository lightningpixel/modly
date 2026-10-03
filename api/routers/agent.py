"""
Agent chat endpoint — runs a tool-use loop against Modly's API, on the managed
local llama.cpp server or any OpenAI-compatible provider.
"""
import asyncio
import json
import re
import uuid
from typing import Optional

import httpx
from fastapi import APIRouter
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


def _extract_thinking(msg: dict) -> tuple[str, str | None]:
    """Return (clean_content, thinking_text). Handles llama-server's
    reasoning_content field and inline <think> tags."""
    content = msg.get("content") or ""
    thinking = msg.get("reasoning_content") or None
    if not thinking:
        match = re.search(r"<think>(.*?)</think>", content, re.DOTALL)
        if match:
            thinking = match.group(1).strip()
            content = (content[: match.start()] + content[match.end() :]).strip()
    return content, thinking


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
            slot = await asyncio.to_thread(llama_pool.ensure, request.model, spec, True)
        except Exception as e:
            return AgentChatResponse(message=f"Could not start the local LLM: {e}")
        base_url = slot.base_url
        headers: dict = {}
        send_images = spec["vision"]
        extra.update(llm_server.sampling_for(request.model))
        if request.thinking == "off":
            extra["chat_template_kwargs"] = {"enable_thinking": False}
    else:
        if not request.provider.base_url:
            return AgentChatResponse(message="No provider URL configured. Set one in Settings → Agent.")
        base_url = request.provider.base_url.rstrip("/")
        headers = _auth_headers(base_url, request.provider.api_key)

    for m in request.messages:
        messages.append(_user_entry(m, send_images))

    actions_done: list[ActionDone] = []
    all_thinking:  list[str]       = []
    final: AgentChatResponse | None = None

    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            for _ in range(10):  # max tool-call rounds
                r = await client.post(
                    f"{base_url}/chat/completions",
                    headers=headers,
                    json={"model": request.model, "messages": messages, "tools": TOOLS, "stream": False, **extra},
                )
                # An external model's vision support is unknown up front, and a
                # text-only one rejects image parts with a 400 that failed the
                # whole turn. Retry once with the images described as omitted.
                if r.status_code == 400 and request.provider.type != "local" and _drop_images(messages):
                    r = await client.post(
                        f"{base_url}/chat/completions",
                        headers=headers,
                        json={"model": request.model, "messages": messages, "tools": TOOLS, "stream": False, **extra},
                    )

                if r.status_code != 200:
                    return AgentChatResponse(message=f"LLM error ({r.status_code}): {_error_detail(r)}")

                msg = r.json()["choices"][0]["message"]
                tool_calls = msg.get("tool_calls") or []
                assistant: dict = {"role": "assistant", "content": msg.get("content") or ""}
                if tool_calls:
                    assistant["tool_calls"] = tool_calls
                messages.append(assistant)

                clean_content, thinking_text = _extract_thinking(msg)
                if thinking_text:
                    all_thinking.append(thinking_text)

                if not tool_calls:
                    final = AgentChatResponse(message=clean_content, actions=actions_done)
                    break

                for tc in tool_calls:
                    fn = tc["function"]
                    result_text, payload = await execute_tool(fn["name"], _tool_arguments(fn.get("arguments")), request.context)
                    actions_done.append(ActionDone(tool=fn["name"], result=result_text, payload=payload))
                    messages.append({"role": "tool", "tool_call_id": tc.get("id", ""), "content": result_text})
    except httpx.HTTPError as e:
        return AgentChatResponse(message=f"Could not reach the LLM at {base_url}: {e}", actions=actions_done)
    finally:
        if slot is not None:
            slot.release()

    # After the release: unload_all() spares a held slot, so unloading while
    # still holding ours would keep the agent's own model on the GPU.
    await _unload_llm_after_workflow(request, actions_done)

    if final is None:
        final = AgentChatResponse(message="Reached maximum tool iterations.", actions=actions_done)
    final.thinking = "\n\n---\n\n".join(all_thinking) if all_thinking else None
    return final
