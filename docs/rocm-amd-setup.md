# Running Modly on AMD GPUs (ROCm)

Modly's extension installer only auto-detects **NVIDIA** GPUs (it probes
`nvidia-smi`). On an AMD system it falls through to the CPU/CUDA path, so an
extension's `torch` install either fails outright or installs a CPU build — no
GPU acceleration.

With a small app-side fix plus two environment prerequisites, you can run
Modly's **pure-PyTorch** extensions on an AMD GPU via **ROCm**.

**Tested on:** AMD Radeon RX 7600 (`gfx1102`) · Ubuntu 26.04 · ROCm 6.3 ·
Hunyuan3D 2 Mini (image → 3D mesh, end-to-end).

## Prerequisites

### 1. Python 3.10–3.13 (NOT 3.14)
Ubuntu 26.04 ships **Python 3.14** by default, and PyTorch publishes **no
wheels for 3.14**. Every extension install fails with
`No matching distribution found for torch`. Install 3.12 (no sudo, via
[uv](https://docs.astral.sh/uv/)):

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
uv python install 3.12
ln -sf "$(uv python find 3.12)" ~/.local/bin/python3.12   # put python3.12 on PATH
```

Modly's `findSystemPython()` tries `python3.12` first, so on the next launch it
rebuilds its backend venv with 3.12.

### 2. ROCm
Install ROCm. [TheRock](https://github.com/ROCm/TheRock) (AMD's modern ROCm
distribution) **officially supports `gfx1102`** (RX 7600). Verify your card is
seen:

```bash
rocminfo | grep -i gfx        # expect a gfx110x agent
rocm-smi --showproductname    # GFX Version: gfx1102
```

### 3. The app-side fix (this change)
`electron/main/ipc-handlers.ts` now calls `detectRocmGpu()`: when **no NVIDIA
GPU** is present but ROCm is installed and `rocminfo` reports an AMD GPU
(`gfx*`), the app passes `torch_flavor: 'rocm'` to each extension's `setup.py`.
Extension setup scripts that accept `torch_flavor` (e.g. Hunyuan3D 2 Mini) then
install PyTorch from the ROCm wheel index instead of CUDA/CPU.

> Behavior is unchanged for NVIDIA and Apple Silicon users — the ROCm branch
> only triggers on Linux with no NVIDIA GPU + ROCm present.

## Install and run
1. Launch Modly (it recreates its backend venv with Python 3.12 the first time).
2. **Extensions → Install from GitHub**, paste e.g.
   `https://github.com/lightningpixel/modly-hunyuan3d-mini-extension`.
3. The setup log should show `[setup] -> PyTorch + ROCm 7.2` (not `cu118`/CPU).
4. Download the model weights, then **Generate**.

## What works on AMD — and what doesn't
- ✅ **Pure-PyTorch extensions:** Hunyuan3D 2 Mini / Turbo / Fast, Trellis2 GGUF.
- ❌ **TripoSG:** depends on `diso`, a CUDA-only C++ extension. It cannot compile
  or run on AMD (no `nvcc`, and the prebuilt wheel is NVIDIA-only). Use the
  Hunyuan3D variants instead.
- ℹ️ PyTorch-ROCm reports the device as **`cuda`** (e.g. `Loaded on cuda`).
  That's the AMD GPU via HIP — expected, not an error.
- ℹ️ The RX 7600 has **8 GB VRAM**; prefer the "Mini" variants and keep an eye
  on memory.
