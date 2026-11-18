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

## Calling the API from other apps

Scripts, CLIs and other programs (curl, `modly-cli`, the MCP server, OrcaSlicer…) can call the API
with no token or setup.

**Web pages** are refused (403), so a site open in your browser cannot drive Modly. To let a web app
in, list its origin in `MODLY_ORIGINS` before starting Modly (comma-separated, `*` wildcards):

```bash
MODLY_ORIGINS="http://localhost:3000,chrome-extension://*"   # or "*" for every page
```

`<img>` / `<video>` tags send no `Origin`, so the page's `Referer` is used instead. Browsers drop it
from an HTTPS page to the HTTP API: on an HTTPS site, add `crossorigin="anonymous"` to those tags.

The request's `Host` must be `localhost` or an IP address (this blocks DNS rebinding). To reach the
API by a machine name, list it in `MODLY_HOSTS`, e.g. `MODLY_HOSTS=jetson.local`.

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
