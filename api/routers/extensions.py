import asyncio
import json
import re
import subprocess
import sys
from pathlib import Path
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
    gpu_sm     = _detect_gpu_sm()
    gfx_target = _detect_gfx_target()

    # Pass arguments as JSON so setup.py sees torch_flavor. Note this endpoint is
    # a fallback: Electron normally runs setup.py itself, and only that path gets
    # the ROCm index rewriting for extensions that ignore torch_flavor.
    args = json.dumps({
        "python_exe":   sys.executable,
        "ext_dir":      str(ext_dir),
        "gpu_sm":       gpu_sm,
        "cuda_version": 0,
        "accelerator":  "rocm" if gfx_target else ("cuda" if gpu_sm else "cpu"),
        "torch_flavor": "rocm" if gfx_target else ("cuda" if gpu_sm else "cpu"),
        "gfx_target":   gfx_target,
        "platform":     sys.platform,
    })

    # Run setup.py using Modly's embedded Python (sys.executable)
    loop   = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: subprocess.run(
            [sys.executable, str(setup_py), args],
            capture_output=True,
            text=True,
        )
    )

    if result.returncode != 0:
        raise HTTPException(500, f"setup.py failed:\n{result.stderr}")

    return {
        "status":     "ok",
        "gpu_sm":     gpu_sm,
        "gfx_target": gfx_target,
        "output":     result.stdout,
    }


@router.get("/errors")
async def extension_errors():
    """Returns extension loading errors (invalid manifest, failed import, etc.)."""
    from services.generator_registry import generator_registry
    return generator_registry.load_errors()


def _detect_gpu_sm() -> int:
    """
    Returns GPU compute capability as integer (e.g. 86 for SM 8.6), or 0 if no GPU.

    Returns 0 on ROCm too. PyTorch's HIP build answers the whole torch.cuda API,
    so get_device_capability() happily reports (12, 0) for a gfx1200 Radeon —
    indistinguishable from an sm_120 Blackwell, which would send setup.py to the
    CUDA 12.8 index. AMD cards are identified by _detect_gfx_target() instead.
    """
    try:
        import torch
        if torch.version.hip:
            return 0
        if torch.cuda.is_available():
            major, minor = torch.cuda.get_device_capability(0)
            return major * 10 + minor
    except Exception:
        pass
    return 0


def _detect_gfx_target() -> str:
    """
    Returns the ROCm compute target (e.g. "gfx1200"), or "" when there is no AMD GPU.

    Reads the kernel's KFD topology rather than asking torch: this process runs
    in Modly's main venv, which has no torch at all (see api/requirements.txt).
    The amdgpu driver publishes the target on its own, so no ROCm install is
    needed either. Mirrors electron/main/gpu-detect.ts.
    """
    kfd_nodes = Path("/sys/class/kfd/kfd/topology/nodes")
    if not Path("/dev/kfd").exists() or not kfd_nodes.is_dir():
        return ""

    def _prop(text: str, key: str) -> int:
        match = re.search(rf"^{key}\s+(\d+)\s*$", text, re.M)
        return int(match.group(1)) if match else 0

    try:
        nodes = sorted(kfd_nodes.iterdir(), key=lambda p: int(p.name) if p.name.isdigit() else 0)
    except OSError:
        return ""

    for node in nodes:
        try:
            text = (node / "properties").read_text()
        except OSError:
            continue
        # Node 0 is the CPU node (simd_count 0) and carries no compute target.
        if _prop(text, "simd_count") <= 0:
            continue
        # major*10000 + minor*100 + step, minor and step read as hex digits.
        version = _prop(text, "gfx_target_version")
        if version <= 0:
            continue
        major, minor, step = version // 10000, (version % 10000) // 100, version % 100
        if major <= 0 or minor > 15 or step > 15:
            continue
        return f"gfx{major}{minor:x}{step:x}"
    return ""
