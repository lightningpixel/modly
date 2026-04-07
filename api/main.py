"""
Modly FastAPI backend.
Runs locally within the Electron app to provide AI inference endpoints.
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi import HTTPException

from routers import generation, model, optimize, status, settings, extensions, export


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: initialize the registry (instantiates all adapters)
    from services.generator_registry import generator_registry
    generator_registry.initialize()
    yield
    # Shutdown: unload all models
    generator_registry.unload_all()


app = FastAPI(
    title="Modly API",
    version="0.3.1",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(status.router)
app.include_router(settings.router)
app.include_router(model.router,      prefix="/model")
app.include_router(generation.router, prefix="/generate")
app.include_router(optimize.router,    prefix="/optimize")
app.include_router(extensions.router, prefix="/extensions")
app.include_router(export.router,     prefix="/export")

# Serve generated files from workspace — dynamic so path changes take effect immediately
@app.get("/workspace/{full_path:path}")
async def serve_workspace_file(full_path: str):
    import services.generator_registry as reg
    file_path = reg.WORKSPACE_DIR / full_path
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(str(file_path))
