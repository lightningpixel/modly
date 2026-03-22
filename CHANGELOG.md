# Changelog

## v0.1.4-dev (2026-03-22)

### AMD GPU (ROCm) Support

- **Switched PyTorch index to ROCm 6.4** for AMD GPU support (RDNA 4 / gfx1201 tested on RX 9070 XT)
- **Replaced `onnxruntime-gpu` with `onnxruntime`** in requirements.txt — the GPU variant is NVIDIA-only; CPU ONNX runtime works fine for `rembg` background removal
- **GPU auto-detection at install time** (`electron/main/python-setup.ts`): checks `nvidia-smi` (NVIDIA), `rocminfo` (AMD ROCm), or `wmic` (Windows fallback), and passes the correct `--index-url` to pip:
  - NVIDIA: `https://download.pytorch.org/whl/cu128`
  - AMD: `https://download.pytorch.org/whl/rocm6.4`
  - No GPU: `https://download.pytorch.org/whl/cpu`
- **Removed hardcoded `--index-url` from `api/requirements.txt`** — the URL is now injected by `python-setup.ts` at runtime based on detected GPU

### Dev Mode Setup (First-Run Install)

- **Dev mode no longer skips setup** (`electron/main/ipc-handlers.ts`): previously `setup:check` returned `{ needed: false }` when `!app.isPackaged`, meaning the venv and pip install never ran. Now it checks for the existence of `api/.venv/bin/python` (Unix) or `api/.venv/Scripts/python.exe` (Windows)
- **Dev mode creates venv at `api/.venv`** (`electron/main/python-setup.ts`): matches where `resolvePythonExecutable()` looks for it in dev mode
- **Windows dev mode support** (`electron/main/python-setup.ts`): added a new branch in `runFullSetup()` for `win32 && !app.isPackaged` that uses `findSystemPython()` and creates a venv with `Scripts/python.exe`
- **`findSystemPython()` prefers Python 3.12** over 3.14+: the candidate list (`python3.12`, `python3.11`, `python3.10`, `python3`, `python`) ensures PyTorch-compatible Python is selected even on systems where `python3` points to 3.14+

### C++ Extension Compilation

- **Automatic compilation of `texture_baker` and `uv_unwrapper`** during first-run setup (`electron/main/python-setup.ts`): added `buildCppExtensions()` that runs `setup.py build_ext --inplace` for both extensions after pip install completes. Failures are non-fatal (texture features disabled but app still works)
- **Added "Compiling extensions" step** to the setup UI (`src/areas/setup/FirstRunSetup.tsx`)

### Linux Packaged Build (AppImage)

- **Bundled Python 3.11.9 in Linux AppImage** (`package.json`): added `extraResources` for `python-embed` to the `linux` build config — previously only the `win` config included it, so the AppImage had no Python and setup would fail with ENOENT
- **Fixed `getEmbeddedPythonExe()` symlink handling** (`electron/main/python-setup.ts`): python-build-standalone uses symlinks (`python3` -> `python3.11`) which may not survive AppImage packaging. Now tries `bin/python3.11`, `bin/python3`, `bin/python` in order

### Setup UI Improvements

- **Added missing progress steps** to `FirstRunSetup.tsx`: "Finding Python", "Creating environment", and "Compiling extensions" now show in the setup progress indicator alongside the existing "Preparing Python", "Installing pip", and "Installing packages" steps

### Extension System

- **Allow downloading models for unverified extensions** (`src/areas/models/components/ExtensionCard.tsx`): previously the Install button was disabled for extensions without a signature in the official registry. Now any extension can download model weights (the "Unverified" badge still shows as a warning)
- **Added `GenerationCancelled` exception and `_check_cancelled()` method** to `BaseGenerator` (`api/services/generators/base.py`): required by newer extension versions that support cancellation during generation

### New Dependencies

Added to `api/requirements.txt`:
- `omegaconf>=2.3.0` — required by `hy3dshape` (Hunyuan3D 2.1 pipeline)
- `timm>=1.0.0` — required by `hy3dshape` (vision transformer for image encoding)
- `torchdiffeq>=0.2.5` — required by `hy3dshape` (ODE solver for flow matching)
- `pybind11>=2.12.0` — required to compile C++ extensions (`differentiable_renderer`)

### Custom Extensions Created

Created two custom extensions in `~/.config/Modly/extensions/` (user data, not in repo):

- **`hunyuan3d/`** — Full Hunyuan3D 2 model (3.3B params) with Standard/Turbo/Fast variants from `tencent/Hunyuan3D-2`. Uses `hy3dgen` pipeline, supports texture generation
- **`hunyuan3d-2.1/`** — Hunyuan3D 2.1 (latest) from `tencent/Hunyuan3D-2.1`. Uses `hy3dshape` pipeline, shape-only (PBR texture model requires ~21 GB VRAM)

### Build System

- **Linux AppImage** built and placed in `builds/linux/Modly-0.1.3.AppImage`
- **Windows NSIS installer** cross-compiled and placed in `builds/windows/Modly Setup 0.1.3.exe`

### Files Modified

| File | Changes |
|------|---------|
| `api/requirements.txt` | Removed hardcoded CUDA index URL, added ROCm-compatible deps, added omegaconf/timm/torchdiffeq/pybind11 |
| `electron/main/python-setup.ts` | GPU detection, Windows dev mode, C++ extension compilation, embedded Python symlink handling |
| `electron/main/ipc-handlers.ts` | Dev mode setup check for both Unix and Windows, dev mode setup:run passes correct userData path |
| `electron/main/python-bridge.ts` | No changes (already handled dev/packaged correctly) |
| `src/areas/setup/FirstRunSetup.tsx` | Added python/venv/extensions steps to progress UI |
| `src/areas/models/components/ExtensionCard.tsx` | Removed trusted-only gate on Install button |
| `api/services/generators/base.py` | Added `GenerationCancelled` exception class and `_check_cancelled()` method |
| `package.json` | Added `extraResources` for python-embed to Linux build config |

### Known Limitations

- **Hunyuan3D 2.1 texture generation** requires ~21 GB VRAM (PBR paint model) — not feasible on 16 GB cards. Shape-only generation works fine
- **Hunyuan3D Mini texture generation** requires the `hy3dgen` texgen C++ extensions (`custom_rasterizer`, `differentiable_renderer`) to be compiled from the downloaded model's `_hy3dgen/` source. These are NOT compiled automatically by the app — they must be built manually with `pip install --no-build-isolation .` from each extension directory. ROCm users also need `hipsparse`, `hipblaslt`, `hipsolver`, `hipcub`, and `rocthrust` system packages
- **Python 3.14 is not supported** by PyTorch — users on Arch Linux (or similar rolling-release distros) need Python 3.10-3.12 installed separately
- **Windows builds are unsigned** — users will see a SmartScreen warning on first run

### System Requirements Tested

- **OS**: Arch Linux (kernel 6.19.8)
- **GPU**: AMD Radeon RX 9070 XT (gfx1201, RDNA 4)
- **ROCm**: 7.2.0 with HIP runtime
- **Python**: 3.12.13 (system), 3.11.9 (bundled)
- **PyTorch**: 2.9.1+rocm6.4

---

## v0.1.3 (previous release)

- Fix: handle missing file path on drag and drop
- Fix: use requirements.txt hash to trigger reinstall
