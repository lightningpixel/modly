---
name: modly-cli
description: Use when an agent needs to call a running Modly desktop instance from the terminal to generate/export image-to-3D assets through canonical JSON-first automation commands.
version: 1.2.0
author: Modly
license: MIT
metadata:
  hermes:
    tags: [modly, image-to-3d, cli, automation, agents]
    related_skills: []
---

# Modly CLI

## Overview

Modly exposes a local API at `http://127.0.0.1:8765` while the official desktop app is running. The desktop process authenticates that API with a per-session bearer token. The CLI sends it automatically from, in order: `--token`, `MODLY_API_TOKEN`, or `api-token` in Electron userData (`~/Library/Application Support/Modly` on macOS, `%APPDATA%/Modly` on Windows, `~/.config/Modly` on Linux). `GET /health` stays unauthenticated so readiness checks still work.

The stdlib-only CLI at `tools/modly-cli/agent.py` is an agent helper over the canonical automation contract:

- `health`
- `model`
- `workflow-run`
- `capability`
- `process-run`

Final machine-readable JSON is printed to stdout. Progress JSON lines, when requested, are printed to stderr.

## Prerequisites

Launch the official Modly desktop app first, then check readiness:

```bash
python tools/modly-cli/agent.py health
```

Use `--compact` when another agent needs single-line JSON:

```bash
python tools/modly-cli/agent.py --compact health
```

`GET /health` is checked before business operations. If the app is unavailable, failures are structured:

```json
{
  "ok": false,
  "code": "API_UNAVAILABLE",
  "message": "Cannot reach Modly API at ..."
}
```

## Canonical Commands

Inspect models through `/model/*`:

```bash
python tools/modly-cli/agent.py model list
python tools/modly-cli/agent.py model status
python tools/modly-cli/agent.py model params --model active
```

Start or resume workflow runs:

```bash
python tools/modly-cli/agent.py workflow-run start --image ./input.png --wait
python tools/modly-cli/agent.py workflow-run status <run_id>
python tools/modly-cli/agent.py workflow-run cancel <run_id>
```

Generate from an image and export the finished mesh:

```bash
python tools/modly-cli/agent.py generate \
  --image ./input.png \
  --output ./export.glb \
  --progress
```

`generate` is a friendly wrapper around `POST /workflow-runs/from-image` and `GET /workflow-runs/{run_id}`. It does not silently fall back to `/generate/*`. The JSON includes recovery metadata:

```json
{
  "ok": true,
  "run": {"kind": "workflowRun", "id": "..."},
  "workspace_path": "Default/model.glb",
  "export_path": "/absolute/path/to/export.glb",
  "meta": {
    "status_command": "python tools/modly-cli/agent.py workflow-run status ...",
    "cancel_command": "python tools/modly-cli/agent.py workflow-run cancel ...",
    "legacy": false
  }
}
```

Use `--no-export` when the caller only needs the workspace path. The hidden `export` helper remains available to download an existing workspace mesh, but it is not part of the canonical root command set:

```bash
python tools/modly-cli/agent.py export --path Default/model.glb --output ./model.glb
```

Discover capabilities or process runs only when the running server exposes the canonical contract:

```bash
python tools/modly-cli/agent.py capability list
python tools/modly-cli/agent.py process-run status <run_id>
```

If the contract is absent, the CLI fails closed:

```json
{
  "ok": false,
  "code": "UNSUPPORTED_PROCESS",
  "message": "This process is not available through the canonical process-run contract."
}
```

## Model Selection

`--model auto` uses the active model reported by `/model/status`, then validates that id against `/model/all`. Explicit `--model` values are also validated against `/model/all`. The CLI does not infer hidden capabilities from model names, labels, or string fragments.

## Legacy Compatibility

The old `/generate/*` endpoints are explicit compatibility commands:

```bash
python tools/modly-cli/agent.py legacy job <job_id>
python tools/modly-cli/agent.py legacy cancel <job_id>
python tools/modly-cli/agent.py legacy generate --image ./input.png --output ./legacy.glb
```

Legacy responses include `meta.legacy: true`. Top-level `job`, `cancel`, `models`, and `params` aliases may still parse for older scripts, but they are not the documented canonical surface.

## Developer-Only API Helpers

Headless startup helpers live under `dev`:

```bash
python tools/modly-cli/agent.py dev serve-api --print-command
python tools/modly-cli/agent.py dev ensure-server
python tools/modly-cli/agent.py dev ensure-server --start --detach
```

These commands start or inspect only the FastAPI backend. They do not imply Electron/Desktop bridge readiness, scene operation readiness, extension process execution readiness, or full workflow support. Prefer launching the official desktop app for real agent workflows.

## Experimental ComfyUI Helpers

ComfyUI orchestration is outside the canonical Modly contract and lives under `experimental`:

```bash
python tools/modly-cli/agent.py experimental comfy-image \
  --workflow Trellis2Workflow \
  --prompt "clean object render, isolated on white" \
  --comfy-output ./source.png

python tools/modly-cli/agent.py experimental generate-from-workflow \
  --workflow Trellis2-Full \
  --prompt "clean orthographic product render of a stylized robot toy" \
  --output ./export.glb
```

`experimental generate-from-workflow --workflow <name> --output <path>` treats `--output` as the final artifact location. If the ComfyUI history contains a downloadable `.glb`, `.gltf`, `.obj`, `.stl`, or `.ply`, the CLI downloads that asset directly and does not call Modly health or generation. If the workflow only produces an image, the CLI downloads that image and falls back through the canonical Modly workflow-run generation path. If no supported asset or image is found, it fails with `code: "NO_WORKFLOW_OUTPUT"`.

## Hidden Helper Aliases

The top-level `status`, `export`, and `batch` helpers remain parseable for older scripts and agent ergonomics, but root help does not present them as canonical automation primitives. Prefer `health`, `model`, `workflow-run`, `capability`, and `process-run` when documenting the supported contract.

## Batch Workflow

The hidden `batch` helper generates meshes sequentially from a directory or manifest JSON through the canonical `generate` path:

```bash
python tools/modly-cli/agent.py batch \
  --input-dir ./images \
  --output-dir ./meshes \
  --continue-on-error

python tools/modly-cli/agent.py batch \
  --manifest ./jobs.json \
  --output-dir ./meshes
```

Manifest files may be a JSON list, or an object with `jobs` or `images`. Each entry can be a string image path or an object with `image`, optional `output`, and optional `format`.

## Verification Checklist

- [ ] `python tools/modly-cli/agent.py health` returns `ok: true`.
- [ ] `python tools/modly-cli/agent.py model list` returns model entries.
- [ ] `python tools/modly-cli/agent.py generate --image <image> --output <mesh>` returns `ok: true`, `run.kind: workflowRun`, and recovery metadata.
- [ ] The reported `export_path` exists and has non-zero size when export is enabled.
- [ ] `python tools/modly-cli/agent.py workflow-run status <run_id>` can resume polling from metadata.
- [ ] `python tools/modly-cli/test_agent.py` passes.
