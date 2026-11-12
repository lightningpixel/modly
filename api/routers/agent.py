"""
Agent chat endpoint — runs a tool-use loop against Modly's API, on the managed
local llama.cpp server or any OpenAI-compatible provider.
"""
import asyncio
import json
import os
import uuid
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from services import llm_server
from services import ollama_health as ollama_health_service
from services.llm_server import llama_pool
from services.mesh_ops import MeshOp, MeshOpNotFoundError, MeshOpsRegistry, mesh_ops_registry

router = APIRouter(prefix="/agent", tags=["agent"])

# Set by Electron: the port moves off 8765 when another program holds it.
MODLY_API = os.environ.get("MODLY_API_URL", "http://127.0.0.1:8765").rstrip("/")

# Mesh operations reach the chat through the registry: an op declared with an
# `agent` spec becomes a tool, with no change here.
_JSON_TYPES = {"int": "integer", "float": "number", "boolean": "boolean", "select": "string"}


def _show(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _agent_param(schema: dict, description: str) -> dict:
    prop: dict = {"type": _JSON_TYPES.get(schema.get("type"), "string")}
    if schema.get("type") == "select":
        prop["enum"] = [option["value"] for option in schema.get("options", [])]
    hints = []
    if "min" in schema and "max" in schema:
        hints.append(f"range {_show(schema['min'])}–{_show(schema['max'])}")
    if "default" in schema:
        hints.append(f"default {_show(schema['default'])}")
    prop["description"] = f"{description} ({', '.join(hints)})" if hints else description
    return prop


def _agent_required(op: MeshOp) -> list[str]:
    return ["path", *op.agent.required]


def registry_tools(registry: MeshOpsRegistry) -> list[dict]:
    """The function-calling schema of every op the registry exposes to the agent."""
    tools = []
    for op in registry:
        if op.agent is None:
            continue
        schemas = {schema["id"]: schema for schema in op.params_schema}
        properties = {
            "path": {
                "type": "string",
                "description": "Workspace-relative path to the mesh file. Use get_mesh_info to obtain it.",
            },
            **{pid: _agent_param(schemas[pid], text) for pid, text in op.agent.params.items()},
        }
        tools.append({
            "type": "function",
            "function": {
                "name": op.id,
                "description": op.agent.description,
                "parameters": {"type": "object", "properties": properties, "required": _agent_required(op)},
            },
        })
    return tools


def registry_tool_lines(registry: MeshOpsRegistry) -> str:
    """The system prompt's entries for the ops the registry exposes to the agent."""
    lines = []
    for op in registry:
        if op.agent is None:
            continue
        required = _agent_required(op)
        args = ["path", *(pid if pid in required else f"{pid}?" for pid in op.agent.params)]
        lines.append(f"- **{op.id}({', '.join(args)})** — {op.agent.description}")
    return "\n".join(lines)


SYSTEM_PROMPT = f"""\
You are Modly's built-in AI assistant, specialized in 3D modeling and workflow automation.
You help users generate 3D models from images, optimize meshes, and manage workflows directly inside the Modly application.
You can act on the whole app (extensions, model weights, workflows, settings, generation) from any page, without changing page.

## Available tools

- **list_models** — List all downloaded 3D generation models ready to use.
- **generate_from_image(model_id?)** — Generate a 3D model from the image attached to the user's message. Omit model_id to use the model selected in the app.
- **list_extensions** — List installed extensions.
- **get_settings** — Show the storage folders and UI options.
- **install_extension(github_url)** / **uninstall_extension(extension_id)** / **reload_extensions** — Manage extensions.
- **download_model_weights(extension_id, variant?)** / **delete_model_weights(extension_id, variant?)** — Manage model weights.
- **open_workflow(workflow_id)** / **delete_workflow(workflow_id)** — Open a workflow in the editor, or delete it.
- **set_setting(key, value)** — Change `uiScale` (one of `small`, `medium`, `large`, `very-large`), `useAtkinsonFont` or `showRamIndicator` (booleans).
- **set_storage_folder(kind, path)** — Move the `models`, `workspace` or `workflows` folder.
- **undo_mesh** / **redo_mesh** — Undo or redo the last change to the current mesh.
- **navigate(page)** — Switch the app to another page.
- **unload_models** — Unload all 3D generation models from GPU VRAM to free memory.
- **get_mesh_info** — Get info about the current mesh in the 3D viewer (path, triangle count).
{registry_tool_lines(mesh_ops_registry)}
- **arrange_mesh(path, steps, size?, unit?, dimension?)** — Reposition a mesh in one call. Steps: `auto_orient` (lay it flat on its widest side), `normalize_scale` (resize to `size` in `unit`), `recenter` (centre on the origin), `drop_to_ground` (rest it on the ground). Steps always run in that order, whatever order you list them in.
- **get_generation_status(job_id)** — Poll the status of an ongoing 3D generation job.
- **list_workflows** — List all available workflows in Modly.
- **run_workflow(workflow_id)** — Execute a workflow in Modly by its ID. If the user attached an image in their message, it will automatically be used as the workflow's input image.
- **create_workflow(name, input_type, steps, description?)** — Create a new workflow from an ordered list of processing steps. Each step references an extension by its exact `id` and may override its params. The steps run in sequence, the output of one feeding the next. The input source is one of exactly three nodes — `image` (Image), `text` (Text), or `mesh` (Load 3D Mesh) — and an Add-to-Scene output node is appended automatically.

## Rules

- Always use tools to act on the scene — never just describe what you would do.
- If you need the current mesh path, call get_mesh_info first.
- To prepare a mesh for 3D printing, a game engine or the web, call prepare_for_printing, prepare_for_game or prepare_for_web ONCE: each runs every step itself, so never chain repair_mesh, arrange_mesh or decimate for these intents, and no suggest_fixes is needed first. Pass the size or triangle budget only if the user gave one. Report any remaining issue it lists.
- To repair or fix a mesh, call repair_mesh. Report the issues it could not fix, and warn the user when it says the textures were dropped.
- To center, ground, lay flat or resize a mesh, call arrange_mesh ONCE with every requested step — never one call per step.
- To answer questions about a mesh's quality or printability, call inspect_mesh — never guess. Before repairing a mesh, call suggest_fixes to pick the right operations.
- If you need to run a workflow but don't know the ID, call list_workflows first.
- To create a workflow, ONLY use extension ids listed under "Available extensions" in the context. Never invent an id. Chain steps so each step's input type matches the previous step's output type.
- For a workflow's input, `input_type` MUST be exactly one of: `image`, `text`, or `mesh`. These map to the Image, Text, and Load 3D Mesh nodes. Never invent another input. Pick the one matching the first step's expected input.
- uninstall_extension, delete_model_weights, delete_workflow and set_storage_folder ask the user to confirm. If the result says the user declined, acknowledge it and do not retry.
- Never call navigate unless the user explicitly asks to go to a page. Act from where the user is.
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
TOOLS += registry_tools(mesh_ops_registry)


def _function(name: str, description: str, properties: dict | None = None, required: list[str] | None = None) -> dict:
    parameters: dict = {"type": "object", "properties": properties or {}}
    if required:
        parameters["required"] = required
    return {"type": "function", "function": {"name": name, "description": description, "parameters": parameters}}


_EXTENSION_ID = {"type": "string", "description": "Exact extension id, as listed by list_extensions."}
_WORKFLOW_ID = {"type": "string", "description": "Exact workflow id, as listed by list_workflows."}
_VARIANT = {"type": "string", "description": "Optional weights variant, for extensions that offer several. Omit for the default."}

# Server-side tools that read the request context or hand a run to the app.
TOOLS += [
    _function("list_extensions", "List the installed extensions, with their ids and input→output types."),
    _function("get_settings", "Show Modly's storage folders (models, workspace, workflows, extensions) and UI options."),
    _function(
        "generate_from_image",
        "Generate a 3D model from the image the user attached to their message. The app runs the "
        "generation and shows its progress. Needs an attached image.",
        {"model_id": {
            "type": "string",
            "description": "Id of a downloaded generation model (see list_models). Omit to use the model selected in the app.",
        }},
    ),
]

# Tools the app runs itself (Electron IPC, renderer stores), mapped to whether
# the user must confirm them first. The frontend obeys `confirm`.
CLIENT_TOOLS: dict[str, bool] = {
    # Installing runs code downloaded from GitHub: the user must see the URL and click.
    "install_extension": True,
    "uninstall_extension": True,
    "reload_extensions": False,
    "download_model_weights": False,
    "delete_model_weights": True,
    "delete_workflow": True,
    "open_workflow": False,
    "set_setting": False,
    "set_storage_folder": True,
    "undo_mesh": False,
    "redo_mesh": False,
    "navigate": False,
}

TOOLS += [
    _function(
        "install_extension",
        "Install an extension from its GitHub repository URL, then load it.",
        {"github_url": {"type": "string", "description": "Repository URL, e.g. https://github.com/owner/repo."}},
        ["github_url"],
    ),
    _function(
        "uninstall_extension",
        "Uninstall an extension and remove its files. The user is asked to confirm.",
        {"extension_id": _EXTENSION_ID},
        ["extension_id"],
    ),
    _function("reload_extensions", "Reload every installed extension, e.g. after its files changed on disk."),
    _function(
        "download_model_weights",
        "Download the model weights an extension needs. The download continues in the background.",
        {"extension_id": _EXTENSION_ID, "variant": _VARIANT},
        ["extension_id"],
    ),
    _function(
        "delete_model_weights",
        "Delete an extension's downloaded model weights from disk. The user is asked to confirm.",
        {"extension_id": _EXTENSION_ID, "variant": _VARIANT},
        ["extension_id"],
    ),
    _function(
        "delete_workflow",
        "Delete a saved workflow. The user is asked to confirm.",
        {"workflow_id": _WORKFLOW_ID},
        ["workflow_id"],
    ),
    _function(
        "open_workflow",
        "Open a workflow in the workflow editor, without leaving the current page.",
        {"workflow_id": _WORKFLOW_ID},
        ["workflow_id"],
    ),
    _function(
        "set_setting",
        "Change a UI setting. uiScale is one of small, medium, large, very-large; useAtkinsonFont and showRamIndicator are booleans.",
        {
            "key": {"type": "string", "enum": ["uiScale", "useAtkinsonFont", "showRamIndicator"]},
            "value": {"type": ["string", "boolean"], "description": "For uiScale one of: small, medium, large, very-large. A boolean otherwise."},
        },
        ["key", "value"],
    ),
    _function(
        "set_storage_folder",
        "Change where Modly stores models, the workspace or workflows. The user is asked to confirm.",
        {
            "kind": {"type": "string", "enum": ["models", "workspace", "workflows"]},
            "path": {"type": "string", "description": "Absolute path of the new folder."},
        },
        ["kind", "path"],
    ),
    _function("undo_mesh", "Undo the last change to the current mesh in the viewer."),
    _function("redo_mesh", "Redo the last undone change to the current mesh in the viewer."),
    _function(
        "navigate",
        "Switch the app to another page. Use it ONLY when the user explicitly asks to go to a page; "
        "every other tool works from any page.",
        {"page": {"type": "string", "enum": ["generate", "workflows", "models", "settings"]}},
        ["page"],
    ),
]

# Seconds the app has to run a client tool that needs the user's click.
CONFIRM_TIMEOUT = 600.0
_NO_ANSWER = "Error: The app did not answer in time."

# call_id → the turn waiting for the app's answer (see /agent/tool-result).
_pending_client_tools: dict[str, asyncio.Future] = {}


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


def _agent_op(name: str) -> MeshOp | None:
    """The registry op behind a tool name, if the registry exposes it to the agent."""
    try:
        op = mesh_ops_registry.get(name)
    except MeshOpNotFoundError:
        return None
    return op if op.agent is not None else None


async def _run_agent_op(client: httpx.AsyncClient, op: MeshOp, arguments: dict) -> tuple[str, dict | None]:
    # Only the params shown to the model are forwarded; the rest keep their defaults.
    params = {pid: arguments[pid] for pid in op.agent.params if arguments.get(pid) is not None}
    r = await client.post(
        f"{MODLY_API}/optimize/op/{op.id}",
        json={"path": arguments["path"], "params": params},
    )
    r.raise_for_status()
    data = r.json()

    # An op that wrote a mesh answers with its url; analysis ops leave the scene as is.
    payload = None
    if data.get("url"):
        payload = {"type": "mesh_update", "url": data["url"], "face_count": data.get("face_count")}

    if op.agent.format_result is not None:
        text = op.agent.format_result(data)
    elif payload is not None:
        faces = data.get("face_count")
        text = f"{op.label} done. New mesh path: {data['path']}" + (f" ({faces:,} faces)." if faces else ".")
    else:
        text = f"{op.label}: {json.dumps(data)[:2000]}"
    return text, payload


def _extension_lines(extensions: list[dict]) -> list[str]:
    return [
        f"- {e['id']} ({e.get('input', '?')}→{e.get('output', '?')}): {e.get('name', e['id'])}"
        for e in extensions if e.get("id")
    ]


def _id_name_lines(items: list[dict]) -> list[str]:
    return [f"- {i['id']}: {i.get('name') or i['id']}" for i in items if i.get("id")]


_STORAGE_LABELS = {
    "modelsDir": "Models folder",
    "workspaceDir": "Workspace folder",
    "workflowsDir": "Workflows folder",
    "extensionsDir": "Extensions folder",
}


def _settings_lines(context: dict) -> list[str]:
    """The storage folders and UI options the app sent, one per line."""
    storage = context.get("storage") or {}
    ui = context.get("ui") or {}
    lines = [f"{label}: {storage[key]}" for key, label in _STORAGE_LABELS.items() if storage.get(key)]
    lines += [f"{key}: {_show(value)}" for key, value in ui.items() if value is not None]
    return lines


async def execute_tool(
    name: str, arguments: dict, context: dict, *, timeout: float = 60.0, has_image: bool = False,
) -> tuple[str, dict | None]:
    """Execute a tool and return (result_text, action_payload).
    action_payload carries data the frontend needs to react (e.g. new mesh URL).
    has_image: the user's last message carries an image (generate_from_image).
    """
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            op = _agent_op(name)
            if op is not None:
                return await _run_agent_op(client, op, arguments)

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

            elif name == "list_extensions":
                lines = _extension_lines(context.get("extensions") or [])
                if not lines:
                    return "No extensions installed.", None
                return "Installed extensions:\n" + "\n".join(lines), None

            elif name == "get_settings":
                lines = _settings_lines(context)
                if not lines:
                    return "No settings were sent by the app.", None
                return "\n".join(lines), None

            elif name == "generate_from_image":
                if not has_image:
                    return "No image is attached. Ask the user to attach the image to generate from.", None
                model_id = arguments.get("model_id") or None
                models = context.get("models") or []
                label = "the selected model"
                if model_id and models:
                    match = next((m for m in models if m.get("id") == model_id), None)
                    if not match:
                        ids = ", ".join(m["id"] for m in models if m.get("id"))
                        return f"Model '{model_id}' is not downloaded. Use one of: {ids}.", None
                    label = match.get("name") or model_id
                elif model_id:
                    label = model_id
                return f"Generating a 3D model with {label}…", {"type": "generate_from_image", "model_id": model_id}

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
    # Guardrails of the tool loop: tool calls allowed in one turn, and seconds
    # one call may take. The chat sends the values set in Settings → Agent.
    tool_budget: int = Field(default=10, ge=1, le=100)
    tool_timeout: float = Field(default=120.0, gt=0, le=3600)


class ActionDone(BaseModel):
    tool: str
    result: str
    payload: dict | None = None
    error: dict | None = None  # the stop, when a guardrail cut this call short


class AgentChatResponse(BaseModel):
    message: str
    actions: list[ActionDone] = []
    thinking: str | None = None
    stopped: dict | None = None


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


@router.get("/ollama/health")
async def ollama_health(base_url: str = "http://localhost:11434/v1", model: str = ""):
    """Is Ollama up, and is `model` pulled? `status` is `ok`, `unreachable`,
    `model_missing` or `no_model`; the chat panel turns it into a banner.
    Only local addresses are accepted (400 otherwise)."""
    try:
        return await ollama_health_service.check(base_url, model)
    except ValueError as e:
        raise HTTPException(400, str(e))


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


def _done(
    message: str, actions: list[ActionDone], thinking: list[str], error: bool = False,
    stopped: dict | None = None,
) -> dict:
    return {
        "type": "done",
        "message": message,
        "actions": [a.model_dump() for a in actions],
        "thinking": "\n\n---\n\n".join(thinking) if thinking else None,
        # The message reports a failure rather than answering: the chat shows
        # it after whatever text already streamed.
        "error": error,
        # Set when a guardrail ended the tool loop (see _tool_stop).
        "stopped": stopped,
    }


def _tool_stop(code: str, tool: str, limit: float) -> dict:
    """Why a guardrail ended the tool loop, and what the user can do about it.

    tool_budget_exhausted — the model asked for a call past the turn's budget
    tool_timeout          — one call ran past its timeout
    """
    if code == "tool_budget_exhausted":
        message = (
            f"Stopped after {limit:g} tool calls: the agent kept calling tools without "
            f"finishing (it wanted to run {tool} next). Try a more specific request, "
            f"or raise the tool budget in Settings → Agent."
        )
    else:
        message = (
            f"Stopped: {tool} did not finish within {limit:g} s. It may still be "
            f"running in the background. Try again on a lighter mesh, or raise the "
            f"tool timeout in Settings → Agent."
        )
    return {"code": code, "tool": tool, "limit": limit, "message": message}


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
    client_tool — between them, for a tool the app runs: the turn waits for
                  its answer on POST /agent/tool-result with the same call_id
    done — always last: the final answer, every action and the full reasoning
    """
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]

    # Inject scene context so the LLM knows current state
    if request.context:
        ctx_lines = []
        if request.context.get("page"):
            ctx_lines.append(f"Current page: {request.context['page']}")
        if request.context.get("currentMeshPath"):
            ctx_lines.append(f"Current mesh path: {request.context['currentMeshPath']}")
        if request.context.get("meshTriangles"):
            ctx_lines.append(f"Current mesh triangles: {request.context['meshTriangles']:,}")
        if ctx_lines:
            messages.append({
                "role": "system",
                "content": "Scene context:\n" + "\n".join(ctx_lines),
            })

        sections = [
            ("Available extensions (use the exact id when creating workflows)",
             _extension_lines(request.context.get("extensions") or [])),
            ("Downloaded generation models (use the exact id with generate_from_image)",
             _id_name_lines(request.context.get("models") or [])),
            ("Workflows", _id_name_lines(request.context.get("workflows") or [])),
            ("Settings", _settings_lines(request.context)),
        ]
        for title, lines in sections:
            if lines:
                messages.append({"role": "system", "content": f"{title}:\n" + "\n".join(lines)})

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
    # The image generate_from_image would use: the frontend takes it from the
    # user's last message, as run_workflow does.
    last_user = next((m for m in reversed(request.messages) if m.role == "user"), None)
    has_image = bool(last_user and last_user.images)

    actions_done: list[ActionDone] = []
    all_thinking:  list[str]       = []
    final: str | None = None
    error: str | None = None
    stopped: dict | None = None
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

            # Bounded: a round either answers or spends at least one tool call.
            while stopped is None:
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
                    if len(actions_done) >= request.tool_budget:
                        stopped = _tool_stop("tool_budget_exhausted", fn["name"], request.tool_budget)
                        break
                    arguments = _tool_arguments(fn.get("arguments"))
                    yield {"type": "tool_start", "id": tc["id"], "tool": fn["name"], "arguments": arguments}
                    if fn["name"] in CLIENT_TOOLS:
                        # The app runs it and answers through /agent/tool-result.
                        confirm = CLIENT_TOOLS[fn["name"]]
                        call_id = uuid.uuid4().hex
                        answer = asyncio.get_running_loop().create_future()
                        _pending_client_tools[call_id] = answer
                        try:
                            yield {
                                "type": "client_tool", "id": tc["id"], "call_id": call_id,
                                "tool": fn["name"], "arguments": arguments, "confirm": confirm,
                            }
                            # A confirmation waits on the user's click, not on the tool.
                            limit = CONFIRM_TIMEOUT if confirm else request.tool_timeout
                            try:
                                result_text = await asyncio.wait_for(answer, limit)
                            except asyncio.TimeoutError:
                                result_text = _NO_ANSWER
                        finally:
                            # Also runs when the client leaves: nobody will answer.
                            _pending_client_tools.pop(call_id, None)
                            answer.cancel()
                        payload = None
                    else:
                        try:
                            result_text, payload = await asyncio.wait_for(
                                execute_tool(
                                    fn["name"], arguments, request.context,
                                    timeout=request.tool_timeout, has_image=has_image,
                                ),
                                request.tool_timeout,
                            )
                        except asyncio.TimeoutError:
                            # Cancelling the call drops its HTTP request, but a mesh op
                            # the API already started runs to its end in a worker
                            # thread; its result is never shown.
                            stopped = _tool_stop("tool_timeout", fn["name"], request.tool_timeout)
                            result_text, payload = stopped["message"], None
                    actions_done.append(ActionDone(tool=fn["name"], result=result_text, payload=payload, error=stopped))
                    yield {
                        "type": "tool_done", "id": tc["id"], "tool": fn["name"],
                        "result": result_text, "payload": payload, "error": stopped,
                    }
                    if stopped is not None:
                        break
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
    elif stopped is not None:
        yield _done(stopped["message"], actions_done, all_thinking, error=True, stopped=stopped)
    else:
        yield _done(final, actions_done, all_thinking)


class ToolResultRequest(BaseModel):
    call_id: str
    result: str
    error: bool = False


@router.post("/tool-result")
async def agent_tool_result(req: ToolResultRequest):
    """The app's answer to a client_tool event; the waiting turn resumes with it."""
    answer = _pending_client_tools.get(req.call_id)
    if answer is None or answer.done():
        raise HTTPException(status_code=404, detail="No tool call is waiting for this call_id.")
    answer.set_result(f"Error: {req.result}" if req.error else req.result)
    return {"ok": True}


@router.post("/chat", response_model=AgentChatResponse)
async def agent_chat(request: AgentChatRequest):
    """The whole turn at once, for callers that don't read a stream."""
    done: dict = {}
    async for event in _chat_events(request):
        if event["type"] == "done":
            done = event
    return AgentChatResponse(
        message=done["message"], actions=done["actions"], thinking=done["thinking"], stopped=done["stopped"],
    )


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
