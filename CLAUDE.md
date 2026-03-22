# CLAUDE.md — Project Context for Claude Code

## Project Overview

Modly is an Electron + React + Python FastAPI desktop app for AI-powered image-to-3D mesh generation. It supports NVIDIA (CUDA), AMD (ROCm), and CPU-only setups.

## Architecture

- **Frontend**: Electron 33 + React 18 + TypeScript + Three.js (Vite build)
- **Backend**: Python FastAPI on port 8765, spawned by Electron as a child process
- **Extensions**: Model adapters live in `~/.config/Modly/extensions/` (each has `manifest.json` + `generator.py`)
- **Models**: Downloaded from HuggingFace to `~/.config/Modly/models/`

## Key Files

| File | Purpose |
|------|---------|
| `electron/main/python-setup.ts` | First-run setup: GPU detection, venv creation, pip install, C++ extension compilation |
| `electron/main/python-bridge.ts` | Spawns/manages the FastAPI Python process |
| `electron/main/ipc-handlers.ts` | IPC between renderer and main process, setup triggers |
| `api/requirements.txt` | Python dependencies (GPU-agnostic — index URL injected at runtime) |
| `api/services/generator_registry.py` | Discovers and loads extensions dynamically |
| `api/services/generators/base.py` | BaseGenerator ABC with GenerationCancelled, smooth_progress, _check_cancelled |
| `src/areas/setup/FirstRunSetup.tsx` | Setup progress UI |
| `src/areas/models/components/ExtensionCard.tsx` | Extension install UI |
| `package.json` | Build config — `extraResources` for both win and linux include python-embed |

## GPU Detection

`python-setup.ts` detects GPU at install time and passes `--index-url` to pip:
- NVIDIA (`nvidia-smi`): `cu128`
- AMD (`rocminfo`): `rocm6.4`
- None: `cpu`

The `requirements.txt` has NO `--index-url` — only `--extra-index-url https://pypi.org/simple`.

## Python Version

- Bundled: Python 3.11.9 (python-build-standalone for Linux, embeddable for Windows)
- Dev mode: Uses system Python — prefers 3.12 > 3.11 > 3.10 > 3.x (3.14+ not supported by PyTorch)
- `getEmbeddedPythonExe()` tries `python3.11`, `python3`, `python` in order (symlinks may not survive packaging)

## C++ Extensions

Two app-level extensions compiled during setup:
- `api/texture_baker/` — rasterizes barycentric coordinates for texture baking
- `api/uv_unwrapper/` — UV unwrapping for mesh texturing

The `hy3dgen` texture pipeline (used by Hunyuan3D Mini) has its own extensions (`custom_rasterizer`, `differentiable_renderer`) that must be compiled separately from the model's `_hy3dgen/` source directory using `pip install --no-build-isolation .`

AMD ROCm users need these system packages for C++ compilation: `hipsparse`, `hipblaslt`, `hipsolver`, `hipcub`, `rocthrust`.

## Build Commands

```bash
npm install          # JS dependencies
npm run build        # Build Electron app (electron-vite)
npm run preview      # Launch in dev mode
npm run prepare-resources  # Download bundled Python

# Release builds
npx electron-builder --linux AppImage
npx electron-builder --win nsis --x64   # Needs Windows python-embed in resources/
```

For Windows cross-compilation from Linux: swap `resources/python-embed` to the Windows embeddable package before building, swap back after.

## Extension Structure

```
~/.config/Modly/extensions/<extension-id>/
├── manifest.json    # id, name, generator_class, models[], hf_repo, etc.
└── generator.py     # Class extending BaseGenerator from services.generators.base
```

Extensions import from `services.generators.base` (BaseGenerator, smooth_progress, GenerationCancelled).

## Known Limitations

- Hunyuan3D 2.1 texture generation requires ~21 GB VRAM (shape-only works fine)
- Python 3.14+ not supported by PyTorch
- Windows builds are unsigned (SmartScreen warning)
- hy3dgen texgen C++ extensions are NOT auto-compiled by the app setup
