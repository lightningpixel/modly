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

Run like this, the API is **tokenless**: it accepts every request (CORS `*`) and logs
`API token disabled` once at startup. The desktop app instead starts it with
`MODLY_API_TOKEN` (per launch) and `MODLY_ALLOWED_ORIGINS`; every request must then send
`X-Modly-Token: <token>` or get a 401. `GET /health` and the OrcaSlicer route
`/export/slicer/...` (HMAC-signed links from `GET /export/slicer-link`) are exempt. The app
writes the token to `api-token` next to `api-port` in its user data folder for local tools
(MCP server, modly-cli); extensions get it as `MODLY_API_TOKEN`.

## Key endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (used by Electron to detect readiness) |
| GET | `/model/status` | Model download / load status |
| GET | `/model/download` | SSE stream of download progress |
| POST | `/generate/from-image` | Start image-to-3D job |
| POST | `/generate/from-artifact` | Start a typed-artifact model job (`scene` only) |
| GET | `/generate/status/{job_id}` | Poll job status |

## Model

Default: **TripoSR** (`stabilityai/TripoSR`, ~2.4 GB)
Downloaded on first launch to `~/.modly/models/TripoSR/`.
To change model: edit `services/model_manager.py`.
