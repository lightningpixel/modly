---
name: modly-cli
description: Use when an agent needs to call a running Modly desktop instance from the terminal to generate/export image-to-3D assets without using the UI.
version: 1.0.0
author: Modly
license: MIT
metadata:
  hermes:
    tags: [modly, image-to-3d, cli, automation, agents]
    related_skills: []
---

# Modly CLI

## Overview

Modly exposes a local FastAPI server at `http://127.0.0.1:8765` while the desktop app is running. The repository includes a small stdlib-only CLI at `tools/modly-cli/agent.py` so coding agents and scripts can call that API predictably, wait for generation, export the mesh, and receive machine-readable JSON.

The CLI does not start Modly itself. Start the official Modly desktop app first, wait for setup/model installation to finish, then call the CLI.

## When to Use

- You need to verify Modly end-to-end from an agent or CI-like shell.
- You have an input image and want a GLB/STL/OBJ/PLY export path without clicking through the UI.
- You need a stable JSON result containing `job_id`, `workspace_path`, `export_path`, and `bytes_written`.
- You want a tiny integration surface with no npm install and no third-party Python packages.

Do not use this for UI-only workflows such as installing extensions, repairing extension environments, or changing app settings; use the desktop UI for those tasks unless an API endpoint exists.

## Prerequisites

1. Launch the official Modly desktop app.
2. Confirm the app's local API is ready:

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

## Common Commands

List model adapters known to the running app:

```bash
python tools/modly-cli/agent.py models
```

Generate a GLB from an image and export beside the input image:

```bash
python tools/modly-cli/agent.py generate \
  --image /path/to/input.png \
  --format glb \
  --collection Agent \
  --progress
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

For long runs, increase the total timeout:

```bash
python tools/modly-cli/agent.py generate --image input.png --timeout 3600
```

## Output Contract

Successful `generate` calls print one JSON object to stdout:

```json
{
  "ok": true,
  "base_url": "http://127.0.0.1:8765",
  "job_id": "...",
  "status": {"status": "done", "progress": 100, "output_url": "/workspace/..."},
  "workspace_path": "Agent/model.glb",
  "export_format": "glb",
  "export_path": "/absolute/path/to/model.glb",
  "bytes_written": 123456
}
```

Failures also print JSON, but with `ok: false` and a human-readable `error` field. The process exits non-zero.

## Agent Workflow

1. Create or locate an image file.
2. Run `python tools/modly-cli/agent.py health` and stop early if it fails.
3. Optionally run `python tools/modly-cli/agent.py models` to inspect available model ids. By default `generate` uses `--model auto`, preferring an image generation model over texture/refine-only nodes.
4. Run `generate` with an explicit `--output` path when the caller needs deterministic artifacts.
5. Parse stdout JSON and verify:
   - `ok` is `true`
   - `export_path` exists
   - `bytes_written` is greater than zero

## Common Pitfalls

1. **Modly is not running.** The CLI will return `Cannot reach Modly API`. Launch the desktop app first.
2. **First model load can be slow.** Use `--timeout 3600` for first-run downloads or cold GPU loads.
3. **Model id mismatch.** Run `models` and use an id from the returned list. The default is `auto`, which prefers ids/names containing `generate`; pass `--model active` only when the active model accepts raw images.
4. **WSL/Windows path confusion.** From WSL, pass `/mnt/c/...` paths. From Windows PowerShell or cmd, pass normal `C:\...` paths.
5. **Progress output is on stderr.** This keeps stdout parseable as a single final JSON object.

## Verification Checklist

- [ ] `python tools/modly-cli/agent.py health` returns `ok: true`.
- [ ] `python tools/modly-cli/agent.py models` returns at least one model.
- [ ] `generate` exits 0 and prints `ok: true`.
- [ ] The reported `export_path` exists and has non-zero size.
- [ ] The exported mesh opens in Modly or another GLB/STL/OBJ/PLY viewer.
