---
name: modly-cli
description: Use when an agent needs to call a running Modly desktop instance or headless FastAPI backend from the terminal to generate/export image-to-3D assets without using the UI.
version: 1.1.0
author: Modly
license: MIT
metadata:
  hermes:
    tags: [modly, image-to-3d, cli, automation, agents]
    related_skills: []
---

# Modly CLI

## Overview

Modly exposes a local FastAPI server at `http://127.0.0.1:8765` while the desktop app is running. The repository includes a small stdlib-only CLI at `tools/modly-cli/agent.py` so coding agents and scripts can call that API predictably, wait for generation, export meshes, and receive machine-readable JSON.

The preferred path is to launch the official Modly desktop app first. The CLI also includes optional headless helpers (`serve`, `ensure-server --start`) that start only the FastAPI backend when the API directory and Python environment can be discovered or passed explicitly. Headless mode does not install dependencies.

## When to Use

- You need to verify Modly end-to-end from an agent or CI-like shell.
- You have an input image and want a GLB/STL/OBJ/PLY export path without clicking through the UI.
- You need a stable JSON result containing `job_id`, `workspace_path`, `export_path`, and `bytes_written`.
- You want a tiny integration surface with no npm install and no third-party Python packages.
- You need to inspect API/model status, model params, one job, or re-export an existing workspace mesh.

Do not use this for UI-only workflows such as installing extensions, repairing extension environments, or changing app settings unless an API endpoint exists.

## Prerequisites

1. Launch the official Modly desktop app, or start the backend with `serve` if a configured API environment already exists.
2. Confirm the local API is ready:

```bash
python tools/modly-cli/agent.py health
```

A healthy response looks like:

```json
{
  "base_url": "http://127.0.0.1:8765",
  "health": {"status": "ok"},
  "ok": true
}
```

Use `--compact` when another agent needs single-line JSON:

```bash
python tools/modly-cli/agent.py --compact status
```

## Common Commands

Show health plus active model status:

```bash
python tools/modly-cli/agent.py status
```

List model adapters known to the running app:

```bash
python tools/modly-cli/agent.py models
```

Show parameter schema for the auto-selected, active, or explicit model:

```bash
python tools/modly-cli/agent.py params
python tools/modly-cli/agent.py params --model active
python tools/modly-cli/agent.py params --model sf3d
```

Generate a textured GLB from an image and export beside the input image:

```bash
python tools/modly-cli/agent.py generate \
  --image /path/to/input.png \
  --format glb \
  --collection Agent \
  --progress
```

Texture generation is enabled by default for agent runs. When Modly exposes a separate texture/refine node (for example `trellis2/refine`), the CLI runs generation first, passes the generated `mesh_path` into the texture node, then exports the textured result. Agent defaults intentionally use slower texture settings than the UI extension default (`texture_steps=30`, `texture_guidance=3.0`) because low-step/low-guidance texturing can look washed out or poorly aligned. Override these with `--texture-steps`, `--texture-guidance`, or `--texture-params-json`. Use `--no-texture` only when you intentionally want a faster geometry-only smoke test:

```bash
python tools/modly-cli/agent.py generate \
  --image /path/to/input.png \
  --output /path/to/fast-geometry.glb \
  --no-texture
```

Use a preconfigured ComfyUI workflow to create the source image first, then feed that into Modly. The default workflow name is `Trellis2Workflow`; pass a JSON path or set `COMFYUI_WORKFLOW_DIR` if the workflow is not exposed through the running ComfyUI `/userdata` API:

```bash
python tools/modly-cli/agent.py generate-from-workflow \
  --workflow Trellis2Workflow \
  --prompt "clean orthographic product render of a stylized robot toy, centered, white background" \
  --output /path/to/export.glb \
  --progress
```

For debugging the ComfyUI side only, save just the first image output:

```bash
python tools/modly-cli/agent.py comfy-image \
  --workflow Trellis2Workflow \
  --prompt "clean object render, isolated on white" \
  --comfy-output /path/to/source.png
```

Generate with an explicit output path:

```bash
python tools/modly-cli/agent.py generate \
  --image /path/to/input.png \
  --output /path/to/export.glb
```

Use a non-default model and model-specific JSON parameters:

```bash
python tools/modly-cli/agent.py generate \
  --image /path/to/input.png \
  --model sf3d \
  --params-json '{"foreground_ratio":0.85}'
```

Check or cancel an existing generation job:

```bash
python tools/modly-cli/agent.py job <job_id>
python tools/modly-cli/agent.py cancel <job_id>
```

Export an existing workspace mesh path without running generation:

```bash
python tools/modly-cli/agent.py export \
  --path Agent/foo.glb \
  --output ./foo.glb
```

Generate meshes sequentially from a directory or manifest JSON:

```bash
python tools/modly-cli/agent.py batch \
  --input-dir ./images \
  --output-dir ./meshes \
  --continue-on-error

python tools/modly-cli/agent.py batch \
  --manifest ./jobs.json \
  --output-dir ./meshes
```

Manifest files may be a JSON list, or an object with `jobs`/`images`. Each entry can be a string image path or an object with `image`, optional `output`, and optional `format`.

Start or inspect the headless backend command:

```bash
python tools/modly-cli/agent.py serve --print-command
python tools/modly-cli/agent.py ensure-server
python tools/modly-cli/agent.py ensure-server --fail-on-unavailable
python tools/modly-cli/agent.py ensure-server --start --detach
```

## Headless Backend Notes

- `serve` starts `python -m uvicorn main:app` in the Modly API directory; it does not launch Electron.
- `serve` does not install dependencies. If setup has not run, launch desktop Modly once or pass explicit `--api-dir` and `--python` paths after setup.
- `ensure-server --start` checks health first, then starts `serve` behavior only if the API is unavailable.
- `ensure-server` reports `ok: false` with exit 0 by default when the server is unavailable; add `--fail-on-unavailable` when an agent/CI step should exit non-zero.
- Do not use `ensure-server --start` when the desktop app is already managing the API.
- Useful explicit flags: `--api-dir`, `--python`, `--models-dir`, `--workspace-dir`, `--extensions-dir`, `--model`, `--hf-token`.

## Output Contract

Successful `generate` calls print one JSON object to stdout:

```json
{
  "ok": true,
  "base_url": "http://127.0.0.1:8765",
  "image": "/absolute/path/to/input.png",
  "model_id": "sf3d",
  "job_id": "...",
  "status": {"status": "done", "progress": 100, "output_url": "/workspace/..."},
  "workspace_path": "Agent/model_textured.glb",
  "geometry_workspace_path": "Agent/model.glb",
  "texture_model_id": "trellis2/refine",
  "texture_job_id": "...",
  "export_format": "glb",
  "texture_enabled": true,
  "export_path": "/absolute/path/to/export.glb",
  "bytes_written": 123456
}
```

Failures also print JSON, but with `ok: false` and a human-readable `error` field. The process exits non-zero.

Progress output from `generate` / `batch` is emitted to stderr when `--progress` is passed, keeping stdout parseable as one final JSON object. Add `--quiet` to suppress progress.

## Agent Workflow

1. Create or locate an image file.
2. Run `python tools/modly-cli/agent.py health` or `status` and stop early if it fails.
3. Optionally run `models` and `params` to inspect available model ids and parameter schema. By default `generate` uses `--model auto`, preferring an image generation model over texture/refine-only nodes, and then auto-selects a texture/refine model for a second pass when available.
4. If the desired source asset should come from a preconfigured ComfyUI workflow, run `generate-from-workflow --workflow Trellis2Workflow --prompt ...` instead of manually creating an image file. Use `comfy-image` first when debugging the ComfyUI prompt/workflow output.
5. Run `generate` with an explicit `--output` path when the caller needs deterministic artifacts. Add `--no-texture` only for intentional geometry-only smoke tests.
6. Parse stdout JSON and verify:
   - `ok` is `true`
   - `export_path` exists
   - `bytes_written` is greater than zero
7. If a re-export is needed, call `export --path <workspace_path> --output <dest>`.

## Common Pitfalls

1. **Modly is not running.** The CLI will return `Cannot reach Modly API`. Launch the desktop app first or use `ensure-server --start` only when an API environment is ready.
2. **First model load can be slow.** Use `--timeout 3600` for first-run downloads or cold GPU loads.
3. **Model id mismatch.** Run `models` and use an id from the returned list. The default is `auto`, which prefers ids/names containing `generate`; pass `--model active` only when the active model accepts raw images.
4. **Untextured smoke-test exports.** `generate` enables textures by default. If a mesh is gray/white, check that the command or manifest did not pass `--no-texture`, and inspect the returned `texture_enabled` field.
5. **WSL/Windows path confusion.** From WSL, pass `/mnt/c/...` paths. From Windows PowerShell or cmd, pass normal `C:\...` paths.
6. **Progress output is on stderr.** This keeps stdout parseable as a single final JSON object.
7. **Headless startup is not setup.** It starts an existing configured backend; it does not create a venv, download models, or repair dependencies.

## Verification Checklist

- [ ] `python tools/modly-cli/agent.py health` returns `ok: true`.
- [ ] `python tools/modly-cli/agent.py status` returns `ok`, `health`, and `model`.
- [ ] `python tools/modly-cli/agent.py models` returns at least one model.
- [ ] `python tools/modly-cli/agent.py params` returns a parameter schema.
- [ ] `generate` exits 0 and prints `ok: true` with `texture_enabled: true` unless `--no-texture` was intentionally passed.
- [ ] The reported `export_path` exists and has non-zero size.
- [ ] `export --path <workspace_path>` can re-export the generated mesh.
- [ ] The exported mesh opens in Modly or another GLB/STL/OBJ/PLY viewer.
- [ ] `python tools/modly-cli/test_agent.py` passes.
