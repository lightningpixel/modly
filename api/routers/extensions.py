import asyncio
import json
import os
import platform as platform_module
import re
import subprocess
import sys
from pathlib import Path
from fastapi import APIRouter, Body, HTTPException

router = APIRouter(tags=["extensions"])


@router.post("/reload")
async def reload_extensions(payload: dict | None = Body(default=None)):
    """
    Re-scans the extensions/ folder and reloads the registry without restarting FastAPI.
    Unloads all currently loaded generators before reloading.
    """
    from services.generator_registry import generator_registry
    validation_capability = None
    if isinstance(payload, dict):
        candidate = payload.get("validationCapability")
        if isinstance(candidate, dict):
            validation_capability = candidate
    generator_registry.reload(validation_capability)
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

    # Detect GPU compute capability. NVIDIA keeps detection priority, exactly
    # like electron/main/gpu-detect.ts: a Ryzen APU beside an NVIDIA dGPU must
    # resolve to CUDA on both code paths.
    gpu_sm, cuda_version = _detect_nvidia_gpu()
    gfx_target           = "" if gpu_sm else _detect_gfx_target()
    flavor               = "cuda" if gpu_sm else ("rocm" if gfx_target else "cpu")

    # Pass arguments as JSON so setup.py sees torch_flavor. The keys mirror
    # runExtensionSetup in electron/main/ipc-handlers.ts exactly — setup.py
    # scripts read the same contract whichever side launched them. Note this
    # endpoint is a fallback: Electron normally runs setup.py itself, and only
    # that path gets the ROCm index rewriting for extensions that ignore
    # torch_flavor.
    args = json.dumps({
        "python_exe":      sys.executable,
        "ext_dir":         str(ext_dir),
        "gpu_sm":          gpu_sm,
        "cuda_version":    cuda_version,
        "accelerator":     flavor,
        "torch_flavor":    flavor,
        "gfx_target":      gfx_target,
        "torch_index_url": _rocm_index_url() if flavor == "rocm" else "",
        "platform":        sys.platform,
        "arch":            _node_arch(),
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


def _detect_nvidia_gpu() -> tuple[int, int]:
    """
    Returns (compute capability, max CUDA version) — e.g. (86, 124) — or (0, 0)
    when there is no NVIDIA GPU.

    Asks nvidia-smi rather than torch: this process runs in Modly's main venv,
    which has no torch at all (see api/requirements.txt), so a torch import
    always failed here and silently reported every machine as CPU-only. Asking
    the driver also sidesteps the ROCm ambiguity — PyTorch's HIP build answers
    the whole torch.cuda API, reporting (12, 0) for a gfx1200 Radeon exactly
    like an sm_120 Blackwell. Mirrors parseNvidiaSmi in
    electron/main/gpu-detect.ts, including the driver → CUDA version table.
    """
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=compute_cap,driver_version", "--format=csv,noheader"],
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return 0, 0
    if result.returncode != 0:
        return 0, 0

    line = result.stdout.strip().splitlines()[0].strip() if result.stdout.strip() else ""
    if not line:
        return 0, 0
    parts = [part.strip() for part in line.split(",")]

    try:
        sm = round(float(parts[0]) * 10)
    except (ValueError, IndexError):
        sm = 86
    try:
        driver_major = int((parts[1] if len(parts) > 1 else "0").split(".")[0])
    except ValueError:
        driver_major = 0

    cuda_version = 118  # safe minimum
    for threshold, version in (
        (570, 128), (560, 126), (555, 125), (550, 124),
        (545, 123), (535, 122), (530, 121), (525, 120), (520, 118),
    ):
        if driver_major >= threshold:
            cuda_version = version
            break
    return sm, cuda_version


def _rocm_index_url() -> str:
    """The pip index a ROCm torch install must come from. Mirrors
    resolveRocmTorchSpec in electron/main/gpu-detect.ts."""
    override = os.environ.get("MODLY_ROCM_INDEX", "").strip()
    if override:
        return override
    if sys.platform == "win32":
        return "https://repo.amd.com/rocm/whl-multi-arch/"
    return "https://download.pytorch.org/whl/rocm7.2"


def _node_arch() -> str:
    """platform.machine() mapped onto Node's process.arch vocabulary, so
    setup.py sees the same values whichever side launched it."""
    machine = platform_module.machine().lower()
    if machine in ("x86_64", "amd64"):
        return "x64"
    if machine in ("aarch64", "arm64"):
        return "arm64"
    return machine


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

    # Among GPU nodes the largest simd_count wins, mirroring parseKfdGfxTarget
    # in electron/main/gpu-detect.ts: on an APU + dGPU machine the APU commonly
    # gets the lower node number, and the discrete card has more SIMDs.
    best_target, best_simd = "", 0
    for node in nodes:
        try:
            text = (node / "properties").read_text()
        except OSError:
            continue
        # Node 0 is the CPU node (simd_count 0) and carries no compute target.
        simd_count = _prop(text, "simd_count")
        if simd_count <= 0:
            continue
        # major*10000 + minor*100 + step, minor and step read as hex digits.
        version = _prop(text, "gfx_target_version")
        if version <= 0:
            continue
        major, minor, step = version // 10000, (version % 10000) // 100, version % 100
        if major <= 0 or minor > 15 or step > 15:
            continue
        if simd_count > best_simd:
            best_target, best_simd = f"gfx{major}{minor:x}{step:x}", simd_count
    return best_target
