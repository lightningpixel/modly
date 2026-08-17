# Modly — FastAPI Backend

Local Python server started and managed by Electron.

## Setup

```bash
cd api
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate

pip install -r requirements.txt
```

## Run (development)

```bash
uvicorn main:app --host 127.0.0.1 --port 8765 --reload
```

The desktop app always starts this server with `MODLY_API_TOKEN` set. Requests other than `GET /health` then require:

```
Authorization: Bearer <token>
```

or `X-Modly-Token: <token>`. Electron writes the token to `userData/api-token` (mode `0600`) so the CLI/MCP client can pick it up. Headless `uvicorn` without the env var stays usable on a trusted machine, but non-loopback `Host` / `Origin` values are still rejected. Set `MODLY_API_ALLOW_REMOTE=1` only when you also set a token and bind beyond loopback.

```bash
export MODLY_API_TOKEN=$(python -c 'import secrets; print(secrets.token_hex(32))')
curl -H "Authorization: Bearer $MODLY_API_TOKEN" http://127.0.0.1:8765/model/all
```

## Key endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (used by Electron to detect readiness) |
| GET | `/model/status` | Model download / load status |
| GET | `/model/download` | SSE stream of download progress |
| POST | `/generate/from-image` | Start image-to-3D job |
| GET | `/generate/status/{job_id}` | Poll job status |

## Model

Default: **TripoSR** (`stabilityai/TripoSR`, ~2.4 GB)
Downloaded on first launch to `~/.modly/models/TripoSR/`.
To change model: edit `services/model_manager.py`.
