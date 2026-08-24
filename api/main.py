"""
Modly FastAPI backend.
Runs locally within the Electron app to provide AI inference endpoints.
"""
import logging
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi import HTTPException

from services.stdio_utf8 import ensure_utf8_stdio
ensure_utf8_stdio()  # must run before any print/logging hits the pipe

from routers import generation, model, optimize, status, settings, extensions, export, workflow_runs, agent, llm


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: initialize the registry (instantiates all adapters)
    from services.generator_registry import generator_registry
    generator_registry.initialize()
    yield
    # Shutdown: unload all models and stop the local LLM server
    generator_registry.unload_all()
    from services.llm_server import llama_pool
    llama_pool.unload_all()


class _StatusFilter(logging.Filter):
    def filter(self, record):
        return "/generate/status/" not in record.getMessage()

logging.getLogger("uvicorn.access").addFilter(_StatusFilter())


app = FastAPI(
    title="Modly API",
    version="0.4.1",
    lifespan=lifespan,
)

API_TOKEN = os.environ.get("MODLY_API_TOKEN") or ""
_TOKEN_HEADER = "x-modly-token"
# Reachable before a client could possibly have the token, and harmless: the
# health probe is how python-bridge.ts waits for the server to come up, and a
# CORS preflight is a browser asking permission - it carries no custom header
# by definition, and answering it grants nothing on its own.
_OPEN_PATHS = {"/health"}


@app.middleware("http")
async def require_api_token(request: Request, call_next):
    """Reject anything that cannot prove it is a local Modly client.

    The server listens on loopback, which stops other machines but not the
    user's own browser: a page on any site can POST to 127.0.0.1:8765, and
    with CORS wide open it can read the answer too. That made every endpoint
    here remotely reachable - the agent's memory, the workspace files, and
    `POST /settings/paths`, which repoints the workspace at any directory.

    The token is generated per launch by the main process and handed to the
    renderer by header injection (electron/main/api-token.ts); other local
    processes read it from MODLY_API_TOKEN or ~/.modly/api-token. When the
    variable is unset - tests, `uvicorn main:app` by hand, the eval harness -
    the check is off and nothing changes.
    """
    if API_TOKEN and request.method != "OPTIONS" and request.url.path not in _OPEN_PATHS:
        if request.headers.get(_TOKEN_HEADER) != API_TOKEN:
            return JSONResponse(status_code=401, content={"detail": "Missing or invalid API token"})
    return await call_next(request)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    # drei's SplatLoader reads Content-Length to size its buffers; cross-origin
    # JS can only see it when the server explicitly exposes the header.
    expose_headers=["Content-Length"],
)

app.include_router(status.router)
app.include_router(settings.router)
app.include_router(model.router,      prefix="/model")
app.include_router(generation.router, prefix="/generate")
app.include_router(optimize.router,    prefix="/optimize")
app.include_router(extensions.router, prefix="/extensions")
app.include_router(export.router,          prefix="/export")
app.include_router(workflow_runs.router,   prefix="/workflow-runs")
app.include_router(agent.router)
app.include_router(llm.router,             prefix="/llm")

# Serve generated files from workspace — dynamic so path changes take effect immediately
@app.get("/workspace/{full_path:path}")
async def serve_workspace_file(full_path: str):
    import services.generator_registry as reg
    from services.safe_paths import UnsafePath, resolve_within
    # Confined, not just joined: "..%2F.." and "..\.." both survive the URL
    # router and used to serve any file on the disk — readable from any web page
    # the user has open, since the API answers with Access-Control-Allow-Origin.
    try:
        file_path = resolve_within(reg.WORKSPACE_DIR, full_path)
    except UnsafePath:
        raise HTTPException(status_code=400, detail="Invalid path")
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(str(file_path))
