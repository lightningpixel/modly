import asyncio
import subprocess
import sys
from fastapi import APIRouter, HTTPException

router = APIRouter(tags=["extensions"])


@router.post("/reload")
async def reload_extensions():
    """
    Re-scans the extensions/ folder and reloads the registry without restarting FastAPI.
    Unloads all currently loaded generators before reloading.
    """
    from services.generator_registry import generator_registry
    generator_registry.reload()
    return {
        "reloaded": True,
        "models":   list(generator_registry._generators.keys()),
        "errors":   generator_registry.load_errors(),
    }


@router.post("/setup/{ext_id}")
async def setup_extension(ext_id: str):
    """
    Creates the isolated venv for an extension by running its setup.py.
    Called automatically after installing an extension from GitHub.
    Runs setup.py with Modly's embedded Python and the detected GPU SM.
    """
    from services.generator_registry import EXTENSIONS_DIR

    if EXTENSIONS_DIR is None or not EXTENSIONS_DIR.exists():
        raise HTTPException(400, "EXTENSIONS_DIR not configured")

    ext_dir  = EXTENSIONS_DIR / ext_id
    setup_py = ext_dir / "setup.py"

    if not ext_dir.exists():
        raise HTTPException(404, f"Extension '{ext_id}' not found in {EXTENSIONS_DIR}")
    if not setup_py.exists():
        # No setup.py → legacy extension, nothing to do
        return {"status": "skipped", "reason": "no setup.py"}

    # Detect GPU compute capability
    gpu_sm = _detect_gpu_sm()

    # Run setup.py using Modly's embedded Python (sys.executable)
    loop   = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: subprocess.run(
            [sys.executable, str(setup_py), sys.executable, str(ext_dir), str(gpu_sm)],
            capture_output=True,
            text=True,
        )
    )

    if result.returncode != 0:
        raise HTTPException(500, f"setup.py failed:\n{result.stderr}")

    return {
        "status": "ok",
        "gpu_sm": gpu_sm,
        "output": result.stdout,
    }


@router.get("/errors")
async def extension_errors():
    """Returns extension loading errors (invalid manifest, failed import, etc.)."""
    from services.generator_registry import generator_registry
    return generator_registry.load_errors()


def _detect_gpu_sm() -> int:
    """Returns GPU compute capability as integer (e.g. 86 for SM 8.6), or 0 if no GPU."""
    try:
        import torch
        if torch.cuda.is_available():
            major, minor = torch.cuda.get_device_capability(0)
            return major * 10 + minor
    except Exception:
        pass
    return 0
