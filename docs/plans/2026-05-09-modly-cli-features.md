# Modly CLI Feature Expansion Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a few high-leverage, lightweight features to `modly-cli` while keeping it stdlib-only, small, agent-friendly, and easy to verify.

**Architecture:** Keep `tools/modly-cli/agent.py` as a single-file Python CLI. Add small helper functions rather than a framework. Prefer API wrappers around Modly's existing FastAPI endpoints. Add headless mode as an optional `serve` / `ensure-server` path that starts only the FastAPI backend, without launching Electron UI, when paths can be discovered safely.

**Tech Stack:** Python stdlib (`argparse`, `json`, `urllib`, `subprocess`, `pathlib`, `os`, `signal`, `time`), existing Modly FastAPI API, existing Electron/Python setup paths as reference only.

---

## Scope and Non-Goals

### In Scope

1. Preserve current commands:
   - `health`
   - `models`
   - `generate`
2. Add small agent-oriented commands:
   - `params` — get model parameter schema.
   - `status` — get active model status and API health in one JSON object.
   - `job` — poll/check one generation job by id.
   - `cancel` — cancel one generation job by id.
   - `export` — export an existing workspace mesh path to a local file.
   - `batch` — generate multiple images sequentially from a directory or manifest JSON.
3. Add small quality-of-life flags:
   - `--compact` for one-line JSON output.
   - `--quiet` to suppress progress/errors except final JSON.
   - `--fail-on-unavailable` where applicable, keeping nonzero exit codes.
4. Add optional headless mode:
   - `serve` starts the Python FastAPI backend without opening Modly UI.
   - `ensure-server` checks API health, and optionally starts `serve` if unavailable.
5. Update `tools/modly-cli/SKILL.md` and README examples.

### Non-Goals

- Do not add Click/Typer/Rich/requests or other dependencies.
- Do not redesign Modly's API.
- Do not implement extension installation/repair through the CLI in this pass.
- Do not package a global binary yet; keep invocation as `python tools/modly-cli/agent.py ...`.
- Do not make headless mode perform first-run dependency installation unless the venv already exists or the user explicitly passes a setup flag in a future feature.

---

## Current File Map

- Main CLI: `tools/modly-cli/agent.py`
- CLI skill: `tools/modly-cli/SKILL.md`
- README CLI section: `README.md:94-103`
- API endpoints already used:
  - `GET /health`
  - `GET /model/all`
  - `GET /model/status`
  - `POST /generate/from-image`
  - `GET /generate/status/{job_id}`
  - `POST /generate/cancel/{job_id}`
  - `GET /export/{fmt}?path=...`
- Electron backend launch reference:
  - `electron/main/python-bridge.ts:50-62`
  - `electron/main/settings-store.ts`
  - `electron/main/python-setup.ts`

---

## Design Notes

### Keep Output Parseable

- Default command output remains pretty JSON.
- `--compact` prints one-line JSON via `json.dumps(data, separators=(",", ":"), sort_keys=True)`.
- Progress stays on stderr.
- Final machine-readable result stays on stdout.

### Keep Code Small

Target final `agent.py` size: under ~500 lines after this batch.

Suggested structure inside the single file:

```python
# constants / errors
# JSON + HTTP helpers
# path/headless helpers
# command functions
# parser construction
# main()
```

### Headless Mode Feasibility

Headless mode is feasible without Electron UI because Electron currently starts the backend by spawning:

```text
python -m uvicorn main:app --host 127.0.0.1 --port 8765
cwd = api directory
MODELS_DIR / WORKSPACE_DIR / EXTENSIONS_DIR from settings
SELECTED_MODEL_ID, HUGGING_FACE_HUB_TOKEN, HF_TOKEN env vars
```

The lightest version should:

1. Prefer explicit user-provided paths:
   - `--api-dir`
   - `--python`
   - `--models-dir`
   - `--workspace-dir`
   - `--extensions-dir`
2. If not provided, discover common locations:
   - Repo dev API: `<repo>/api`
   - Dev venv: `<repo>/api/.venv/Scripts/python.exe` or `<repo>/api/.venv/bin/python`
   - Windows installed API: `%LOCALAPPDATA%/Programs/Modly/resources/api`
   - Windows Modly settings: `%APPDATA%/Modly/settings.json` if present
3. Refuse with a clear JSON error if required paths cannot be resolved.

This is modest extra work if implemented as `serve` only. It becomes larger if it tries to run first-time setup, so first pass should not auto-install dependencies.

---

## Task 1: Add JSON Output Mode Helpers

**Objective:** Make output formatting reusable before adding more commands.

**Files:**
- Modify: `tools/modly-cli/agent.py`

**Step 1: Add compact output helper**

Replace `_json_print` with an argument-aware helper:

```python
def _json_print(data: dict[str, Any], *, compact: bool = False) -> None:
    if compact:
        print(json.dumps(data, separators=(",", ":"), sort_keys=True))
    else:
        print(json.dumps(data, indent=2, sort_keys=True))
```

**Step 2: Thread `args.compact` into all command output**

Change each command from:

```python
_json_print({...})
```

to:

```python
_json_print({...}, compact=args.compact)
```

For errors in `main`, use:

```python
compact = bool(getattr(args, "compact", False)) if "args" in locals() else False
_json_print({"ok": False, "error": str(exc)}, compact=compact)
```

**Step 3: Add parser flag**

In `build_parser()` add:

```python
parser.add_argument("--compact", action="store_true", help="Print compact one-line JSON")
```

**Step 4: Verify**

Run:

```bash
python3 -m py_compile tools/modly-cli/agent.py
python3 tools/modly-cli/agent.py --help
python3 tools/modly-cli/agent.py --compact --base-url http://127.0.0.1:8765 health
```

Expected:
- compile succeeds
- help includes `--compact`
- compact output is a single JSON line when Modly is running

---

## Task 2: Add `status` Command

**Objective:** Provide one agent-friendly snapshot for API health + active model.

**Files:**
- Modify: `tools/modly-cli/agent.py`
- Modify: `tools/modly-cli/SKILL.md`

**Step 1: Implement command function**

Add:

```python
def cmd_status(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    health = _request_json("GET", f"{base_url}/health", timeout=args.request_timeout)
    model = _request_json("GET", f"{base_url}/model/status", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "health": health, "model": model}, compact=args.compact)
    return 0
```

**Step 2: Add parser subcommand**

```python
status = sub.add_parser("status", help="Show API health and active model status")
status.set_defaults(func=cmd_status)
```

**Step 3: Update skill**

Add a short example under Common Commands:

```bash
python tools/modly-cli/agent.py status
```

**Step 4: Verify**

Run:

```bash
python3 -m py_compile tools/modly-cli/agent.py
python3 tools/modly-cli/agent.py status
```

Expected JSON contains `ok`, `health`, and `model`.

---

## Task 3: Add `params` Command

**Objective:** Let agents discover model-specific parameters without reading UI code.

**Files:**
- Modify: `tools/modly-cli/agent.py`
- Modify: `tools/modly-cli/SKILL.md`

**Step 1: Implement command function**

Use existing API `GET /model/params?model_id=...`.

```python
def cmd_params(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    model_id = args.model
    if model_id == "auto":
        model_id = _choose_auto_model(base_url, args.request_timeout)
    query = ""
    if model_id and model_id != "active":
        query = "?" + urllib.parse.urlencode({"model_id": model_id})
    params = _request_json("GET", f"{base_url}/model/params{query}", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "model_id": model_id, "params": params}, compact=args.compact)
    return 0
```

**Step 2: Add parser subcommand**

```python
params = sub.add_parser("params", help="Show model parameter schema")
params.add_argument("--model", default="auto", help="Model id, 'active', or 'auto' (default: auto)")
params.set_defaults(func=cmd_params)
```

**Step 3: Verify**

Run:

```bash
python3 tools/modly-cli/agent.py params
python3 tools/modly-cli/agent.py params --model active
```

Expected: JSON with `params` array/list.

---

## Task 4: Add `job` and `cancel` Commands

**Objective:** Allow agents to inspect or stop an existing job without rerunning generation.

**Files:**
- Modify: `tools/modly-cli/agent.py`
- Modify: `tools/modly-cli/SKILL.md`

**Step 1: Implement `job` command**

```python
def cmd_job(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    status = _request_json("GET", f"{base_url}/generate/status/{urllib.parse.quote(args.job_id)}", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "job_id": args.job_id, "status": status}, compact=args.compact)
    return 0
```

**Step 2: Implement `cancel` command**

```python
def cmd_cancel(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    result = _request_json("POST", f"{base_url}/generate/cancel/{urllib.parse.quote(args.job_id)}", timeout=args.request_timeout)
    _json_print({"ok": True, "base_url": base_url, "job_id": args.job_id, "cancel": result}, compact=args.compact)
    return 0
```

**Step 3: Add parser subcommands**

```python
job = sub.add_parser("job", help="Show one generation job status")
job.add_argument("job_id")
job.set_defaults(func=cmd_job)

cancel = sub.add_parser("cancel", help="Cancel one generation job")
cancel.add_argument("job_id")
cancel.set_defaults(func=cmd_cancel)
```

**Step 4: Verify**

Start a generation with `--progress`, copy the job id, then:

```bash
python3 tools/modly-cli/agent.py job <job_id>
python3 tools/modly-cli/agent.py cancel <job_id>
```

Expected:
- `job` returns current job status.
- `cancel` returns `cancelled: true` for a running job.

---

## Task 5: Extract Export Logic and Add `export` Command

**Objective:** Export an existing workspace mesh path without triggering generation.

**Files:**
- Modify: `tools/modly-cli/agent.py`
- Modify: `tools/modly-cli/SKILL.md`

**Step 1: Extract helper**

Move export URL/download code from `cmd_generate` into:

```python
def _export_workspace_path(base_url: str, workspace_path: str, fmt: str, dest: Path, *, timeout: float) -> int:
    export_url = f"{base_url}/export/{urllib.parse.quote(fmt)}?{urllib.parse.urlencode({'path': workspace_path})}"
    return _download(export_url, dest, timeout=timeout)
```

**Step 2: Update `cmd_generate` to use helper**

Replace inline export URL + `_download` with `_export_workspace_path(...)`.

**Step 3: Implement command**

```python
def cmd_export(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    dest = Path(args.output).expanduser().resolve()
    bytes_written = _export_workspace_path(base_url, args.path, args.format, dest, timeout=args.request_timeout)
    _json_print({
        "ok": True,
        "base_url": base_url,
        "workspace_path": args.path,
        "export_format": args.format,
        "export_path": str(dest),
        "bytes_written": bytes_written,
    }, compact=args.compact)
    return 0
```

**Step 4: Add parser subcommand**

```python
exp = sub.add_parser("export", help="Export an existing workspace mesh path")
exp.add_argument("--path", required=True, help="Workspace-relative mesh path, e.g. Agent/foo.glb")
exp.add_argument("--output", required=True, help="Destination file path")
exp.add_argument("--format", choices=["glb", "stl", "obj", "ply"], default="glb")
exp.set_defaults(func=cmd_export)
```

**Step 5: Verify**

Use a known `workspace_path` from a previous generation:

```bash
python3 tools/modly-cli/agent.py export \
  --path Agent/1778361682_d6ba1094.glb \
  --output /tmp/modly-export-test.glb
```

Expected: output exists and `bytes_written > 0`.

---

## Task 6: Add Lightweight `batch` Command

**Objective:** Sequentially process multiple images with simple JSON summary output.

**Files:**
- Modify: `tools/modly-cli/agent.py`
- Modify: `tools/modly-cli/SKILL.md`

**Step 1: Extract one-image generation helper**

Refactor `cmd_generate` body into a helper that returns a dict instead of printing:

```python
def _generate_one(args: argparse.Namespace, image_path: Path, output_path: Path | None = None) -> dict[str, Any]:
    # existing cmd_generate logic, but return the success dict
```

Keep `cmd_generate` as:

```python
def cmd_generate(args: argparse.Namespace) -> int:
    result = _generate_one(args, Path(args.image).expanduser().resolve(), Path(args.output).expanduser().resolve() if args.output else None)
    _json_print(result, compact=args.compact)
    return 0
```

**Step 2: Implement image discovery**

Add:

```python
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}

def _iter_images(input_dir: Path) -> list[Path]:
    return sorted(p for p in input_dir.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_SUFFIXES)
```

**Step 3: Implement command**

```python
def cmd_batch(args: argparse.Namespace) -> int:
    input_dir = Path(args.input_dir).expanduser().resolve()
    output_dir = Path(args.output_dir).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    images = _iter_images(input_dir)
    results = []
    failures = 0
    for image in images:
        output = output_dir / f"{image.stem}.{args.format}"
        try:
            results.append(_generate_one(args, image, output))
        except ModlyCliError as exc:
            failures += 1
            results.append({"ok": False, "image": str(image), "error": str(exc)})
            if not args.continue_on_error:
                break
    _json_print({"ok": failures == 0, "count": len(results), "failures": failures, "results": results}, compact=args.compact)
    return 0 if failures == 0 else 1
```

**Step 4: Add parser subcommand**

Reuse generation options where practical. Keep it small; duplicate only the few flags needed.

```python
batch = sub.add_parser("batch", help="Generate meshes for all images in a directory sequentially")
batch.add_argument("--input-dir", required=True)
batch.add_argument("--output-dir", required=True)
batch.add_argument("--format", choices=["glb", "stl", "obj", "ply"], default="glb")
batch.add_argument("--model", default="auto")
batch.add_argument("--collection", default="Agent")
batch.add_argument("--remesh", choices=["quad", "triangle", "none"], default="quad")
batch.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
batch.add_argument("--poll", type=float, default=DEFAULT_POLL_SECONDS)
batch.add_argument("--progress", action="store_true")
batch.add_argument("--continue-on-error", action="store_true")
batch.set_defaults(func=cmd_batch)
```

**Step 5: Verify**

Create a directory with two small images and run:

```bash
python3 tools/modly-cli/agent.py batch --input-dir /tmp/modly-inputs --output-dir /tmp/modly-outputs --continue-on-error
```

Expected: JSON summary lists each image and output path.

---

## Task 7: Add Headless `serve` Command

**Objective:** Start only the FastAPI backend when Electron UI is not needed.

**Files:**
- Modify: `tools/modly-cli/agent.py`
- Modify: `tools/modly-cli/SKILL.md`
- Modify: `README.md`

**Step 1: Add path discovery helpers**

Add helpers with explicit args first, then safe defaults:

```python
def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _default_api_dir() -> Path | None:
    repo_api = _repo_root() / "api"
    if repo_api.exists():
        return repo_api
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA")
        if local:
            installed = Path(local) / "Programs" / "Modly" / "resources" / "api"
            if installed.exists():
                return installed
    return None
```

Add Python discovery:

```python
def _default_python(api_dir: Path) -> Path | None:
    candidates = []
    if sys.platform == "win32":
        candidates.extend([
            api_dir / ".venv" / "Scripts" / "python.exe",
            Path(os.environ.get("APPDATA", "")) / "Modly" / "dependencies" / "venv" / "Scripts" / "python.exe",
        ])
    else:
        candidates.extend([api_dir / ".venv" / "bin" / "python", Path(sys.executable)])
    for candidate in candidates:
        if candidate and candidate.exists():
            return candidate
    return None
```

Note: On Windows installed Modly, dependenciesDir can be user-configured. If discovery fails, require `--python`.

**Step 2: Add settings reader**

Use a best-effort JSON reader:

```python
def _load_modly_settings() -> dict[str, Any]:
    candidates = []
    if sys.platform == "win32" and os.environ.get("APPDATA"):
        candidates.append(Path(os.environ["APPDATA"]) / "Modly" / "settings.json")
    candidates.append(Path.home() / ".config" / "Modly" / "settings.json")
    for path in candidates:
        if path.exists():
            try:
                return json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                return {}
    return {}
```

**Step 3: Implement `serve`**

```python
def cmd_serve(args: argparse.Namespace) -> int:
    api_dir = Path(args.api_dir).expanduser().resolve() if args.api_dir else _default_api_dir()
    if not api_dir or not (api_dir / "main.py").exists():
        raise ModlyCliError("Could not find Modly api directory; pass --api-dir")

    python = Path(args.python).expanduser().resolve() if args.python else _default_python(api_dir)
    if not python or not python.exists():
        raise ModlyCliError("Could not find Modly Python environment; pass --python")

    settings = _load_modly_settings()
    env = os.environ.copy()
    env.update({
        "PYTHONUNBUFFERED": "1",
        "MODELS_DIR": args.models_dir or settings.get("modelsDir") or str(Path.home() / ".modly" / "models"),
        "WORKSPACE_DIR": args.workspace_dir or settings.get("workspaceDir") or str(Path.home() / ".modly" / "workspace"),
        "EXTENSIONS_DIR": args.extensions_dir or settings.get("extensionsDir") or "",
        "SELECTED_MODEL_ID": args.model or os.environ.get("SELECTED_MODEL_ID", ""),
        "HUGGING_FACE_HUB_TOKEN": args.hf_token or settings.get("hfToken") or os.environ.get("HF_TOKEN", ""),
        "HF_TOKEN": args.hf_token or settings.get("hfToken") or os.environ.get("HF_TOKEN", ""),
    })
    cmd = [str(python), "-m", "uvicorn", "main:app", "--host", args.host, "--port", str(args.port)]
    if args.print_command:
        _json_print({"ok": True, "cmd": cmd, "cwd": str(api_dir), "env": {k: env[k] for k in ["MODELS_DIR", "WORKSPACE_DIR", "EXTENSIONS_DIR", "SELECTED_MODEL_ID"]}}, compact=args.compact)
        return 0
    proc = subprocess.Popen(cmd, cwd=str(api_dir), env=env)
    if args.detach:
        _json_print({"ok": True, "pid": proc.pid, "base_url": f"http://{args.host}:{args.port}"}, compact=args.compact)
        return 0
    return proc.wait()
```

**Step 4: Add parser subcommand**

```python
serve = sub.add_parser("serve", help="Start Modly FastAPI backend without Electron UI")
serve.add_argument("--api-dir")
serve.add_argument("--python")
serve.add_argument("--host", default="127.0.0.1")
serve.add_argument("--port", type=int, default=8765)
serve.add_argument("--models-dir")
serve.add_argument("--workspace-dir")
serve.add_argument("--extensions-dir")
serve.add_argument("--model", help="Initial SELECTED_MODEL_ID")
serve.add_argument("--hf-token")
serve.add_argument("--detach", action="store_true", help="Start in background and print pid")
serve.add_argument("--print-command", action="store_true", help="Print resolved command/env without starting")
serve.set_defaults(func=cmd_serve)
```

**Step 5: Verify in dev repo**

Run:

```bash
python3 tools/modly-cli/agent.py serve --print-command
```

Expected: JSON command if API dir and venv are discoverable, or clear JSON error explaining which explicit path is needed.

**Step 6: Verify in Windows installed app**

From Windows Python:

```cmd
C:\Users\joshu\miniconda3\python.exe C:\Users\joshu\PROJECTS\Modly\modly\tools\modly-cli\agent.py serve --print-command
```

Expected: either a resolved installed API command or a clear request for `--python` / `--api-dir`.

---

## Task 8: Add `ensure-server` Command

**Objective:** Give agents one command that makes the API available when possible.

**Files:**
- Modify: `tools/modly-cli/agent.py`
- Modify: `tools/modly-cli/SKILL.md`

**Step 1: Implement health probe helper**

```python
def _try_health(base_url: str, timeout: float) -> dict[str, Any] | None:
    try:
        return _request_json("GET", f"{base_url.rstrip('/')}/health", timeout=timeout)
    except ModlyCliError:
        return None
```

**Step 2: Implement command**

For first pass, keep it simple:

- If health works, print `started: false`.
- If health fails and `--start` is not passed, print `ok: false` with instruction.
- If health fails and `--start` is passed, reuse `serve --detach` behavior.

```python
def cmd_ensure_server(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    health = _try_health(base_url, args.request_timeout)
    if health:
        _json_print({"ok": True, "started": False, "base_url": base_url, "health": health}, compact=args.compact)
        return 0
    if not args.start:
        raise ModlyCliError("Modly API is not running; launch Modly or run ensure-server --start")
    # Build a small Namespace and call cmd_serve with detach=True.
```

**Step 3: Add parser subcommand**

```python
ensure = sub.add_parser("ensure-server", help="Check API health and optionally start headless backend")
ensure.add_argument("--start", action="store_true")
# include the same path flags as serve, but keep help short
ensure.set_defaults(func=cmd_ensure_server)
```

**Step 4: Verify**

With Modly running:

```bash
python3 tools/modly-cli/agent.py ensure-server
```

Expected: `ok: true`, `started: false`.

With Modly not running and explicit paths available:

```bash
python3 tools/modly-cli/agent.py ensure-server --start --detach
```

Expected: `ok: true`, `started: true`, `pid`.

---

## Task 9: Update Documentation and Skill

**Objective:** Keep the repo self-explanatory for future agents.

**Files:**
- Modify: `README.md:94-103`
- Modify: `tools/modly-cli/SKILL.md`

**Step 1: README compact update**

Keep README short. Replace the current Modly CLI section with:

```markdown
## Modly CLI

Agents and scripts can call a running Modly desktop app without using the UI via the stdlib-only CLI:

```bash
python tools/modly-cli/agent.py health
python tools/modly-cli/agent.py generate --image ./input.png --output ./export.glb
```

Useful extras include `status`, `models`, `params`, `job`, `cancel`, `export`, `batch`, and optional headless backend startup with `serve` / `ensure-server --start`. See `tools/modly-cli/SKILL.md` for the agent workflow and output contract.
```

**Step 2: Skill update**

Add command examples for:

```bash
python tools/modly-cli/agent.py status
python tools/modly-cli/agent.py params
python tools/modly-cli/agent.py export --path Agent/foo.glb --output ./foo.glb
python tools/modly-cli/agent.py batch --input-dir ./images --output-dir ./meshes
python tools/modly-cli/agent.py serve --print-command
python tools/modly-cli/agent.py ensure-server --start
```

**Step 3: Keep warning clear**

Document:

- `serve` does not install dependencies.
- If setup has not run, launch desktop Modly once or pass explicit venv/API paths after setup.
- `ensure-server --start` should not be used if the desktop app is already managing the API.

---

## Task 10: Verification Matrix

**Objective:** Ensure the expanded CLI remains reliable and lightweight.

**Files:**
- No code changes unless tests reveal issues.

**Step 1: Static checks**

Run:

```bash
python3 -m py_compile tools/modly-cli/agent.py
python3 tools/modly-cli/agent.py --help
python3 tools/modly-cli/agent.py generate --help
python3 tools/modly-cli/agent.py serve --help
```

Expected: all pass.

**Step 2: Skill checks**

Run a small validator script:

```bash
python3 - <<'PY'
from pathlib import Path
import re
p = Path('tools/modly-cli/SKILL.md')
content = p.read_text(encoding='utf-8')
assert content.startswith('---')
end = content.find('\n---\n', 3)
assert end != -1
fm = content[3:end]
assert re.search(r'^name:\s*modly-cli\s*$', fm, re.M)
desc = re.search(r'^description:\s*(.+)$', fm, re.M).group(1)
assert len(desc) <= 1024
assert content[end+5:].strip()
print('skill ok')
PY
```

Expected: `skill ok`.

**Step 3: API checks with desktop app running**

Run:

```bash
python3 tools/modly-cli/agent.py health
python3 tools/modly-cli/agent.py status
python3 tools/modly-cli/agent.py models
python3 tools/modly-cli/agent.py params
```

Expected: all return `ok: true`.

**Step 4: End-to-end generate/export**

Run with a small known image:

```bash
python3 tools/modly-cli/agent.py generate \
  --image /path/to/input.png \
  --output /path/to/output.glb \
  --timeout 3600 \
  --progress
```

Expected:
- command exits 0
- final JSON has `ok: true`
- `export_path` exists
- `bytes_written > 0`

**Step 5: Export command check**

Use the `workspace_path` from Step 4:

```bash
python3 tools/modly-cli/agent.py export \
  --path <workspace_path> \
  --output /path/to/reexport.glb
```

Expected: re-export succeeds and writes bytes.

**Step 6: Headless dry-run check**

Run:

```bash
python3 tools/modly-cli/agent.py serve --print-command
```

Expected:
- Resolved command printed, or clear JSON error requiring explicit `--api-dir` / `--python`.
- No GUI starts.

**Step 7: Lint note**

Run:

```bash
npm run lint
```

Current expected status: likely fails because ESLint 9 cannot find `eslint.config.js`. Treat that as pre-existing unless this plan also includes fixing repo lint config.

---

## Recommended Implementation Order

1. Task 1 — output helper / `--compact`
2. Task 2 — `status`
3. Task 3 — `params`
4. Task 4 — `job` / `cancel`
5. Task 5 — `export`
6. Task 6 — `batch`
7. Task 7 — `serve` headless dry-run + foreground/detach
8. Task 8 — `ensure-server`
9. Task 9 — docs/skill update
10. Task 10 — verification

This order keeps every step shippable. If headless mode gets messy, stop after Task 6 and still have a useful, small CLI expansion.

---

## Acceptance Criteria

- `tools/modly-cli/agent.py` remains single-file and stdlib-only.
- Existing `health`, `models`, and `generate` behavior remains compatible.
- New commands return JSON with `ok` and useful machine-readable fields.
- `generate` and `batch` final results are parseable from stdout.
- Headless mode either starts FastAPI successfully or fails with a precise JSON error and explicit required flags.
- `tools/modly-cli/SKILL.md` documents all commands and headless limitations.
- End-to-end generation still produces a valid exported mesh path.
