# Running Modly headless on an NVIDIA Jetson (AGX Orin, JetPack 6)

This guide explains how to run Modly's image-to-3D generation on an **NVIDIA Jetson**,
a platform Modly does not officially target. Jetson is `aarch64` with NVIDIA's
Tegra/L4T CUDA stack, so the desktop installers and the stock extension `setup.py`
(which assume `x86_64` + the standard CUDA wheels) don't work as-is.

The good news: **Modly's FastAPI backend is fully standalone and HTTP-driven**, so you
don't need Electron, a display, or the GUI. You run the backend on the Jetson and drive
it with `curl`. The only real work is building the model extension's venv with the
**Jetson-native** PyTorch and working around a broken ONNX Runtime.

> Verified on: **Jetson AGX Orin Developer Kit, 64 GB, JetPack 6.2 (L4T R36.4),
> Python 3.10, CUDA 12.6, compute capability sm_87.**
> Model: the base **Hunyuan3D-2 Mini** extension (`hunyuan3d-mini`), mesh-only
> (no texture). ~6 GB VRAM-class model; comfortable on a 32–64 GB Orin.

---

## TL;DR

The stock setup gets three things wrong on Jetson. After a normal headless install you must:

1. **Replace PyTorch.** The pinned `torch 2.5.1+cu124` SBSA wheel has **no `sm_87`
   kernels** (loads, but every kernel fails with *"no kernel image is available"*).
   Install the Jetson build from the [jetson-ai-lab](https://pypi.jetson-ai-lab.io) index.
2. **Pin `numpy < 2`.** The Jetson torch wheel is compiled against NumPy 1.x, so
   `torch.from_numpy` raises *"Numpy is not available"* under NumPy 2.
3. **Bypass `rembg` / ONNX Runtime.** ONNX Runtime crashes hard on the Tegra CPU
   (*"Unknown CPU vendor"* → C++ abort / segfault). Patch the extension's background
   removal to a NumPy/SciPy implementation.

Full steps below.

---

## 1. System prerequisites

```bash
sudo apt update
sudo apt install -y git python3-venv python3-pip
python3 --version          # expect 3.10.x on JetPack 6
cat /etc/nv_tegra_release   # confirm L4T R36.x (JetPack 6)
/usr/local/cuda/bin/nvcc --version | grep release   # confirm CUDA 12.x
free -h                     # confirm enough unified memory (16 GB+ recommended)
```

Set up working directories and environment:

```bash
export EXTENSIONS_DIR=$HOME/.modly/extensions
export MODELS_DIR=$HOME/.modly/models
export WORKSPACE_DIR=$HOME/.modly/workspace
mkdir -p "$EXTENSIONS_DIR" "$MODELS_DIR" "$WORKSPACE_DIR"
```

---

## 2. Clone Modly and build the API backend venv

The backend itself contains **no PyTorch**; it's just the FastAPI orchestrator plus
mesh post-processing (`trimesh`, `pymeshlab`). `pymeshlab` has `aarch64` wheels, so this
installs cleanly.

```bash
git clone https://github.com/lightningpixel/modly.git ~/modly
cd ~/modly/api
python3 -m venv .venv
./.venv/bin/pip install -U pip
./.venv/bin/pip install -r requirements.txt
```

---

## 3. Fetch the model extension

```bash
git clone https://github.com/lightningpixel/modly-hunyuan3d-mini-extension.git \
  "$EXTENSIONS_DIR/hunyuan3d-mini"
```

The base **Hunyuan3D-2 Mini** extension is the best starting point on Jetson:

- mesh-only generation needs **no native/C++ build** (the texture path's
  `custom_rasterizer` / `differentiable_renderer` are only imported when
  `enable_texture=true`);
- the `hy3dgen` source and model weights **auto-download at runtime**;
- it has no `diso` dependency.

---

## 4. Build the extension venv (with the Jetson fixes)

Create the venv:

```bash
EXT="$EXTENSIONS_DIR/hunyuan3d-mini"
python3 -m venv "$EXT/venv"
"$EXT/venv/bin/pip" install -U pip
```

### 4a. Install Jetson-native PyTorch (not the cu124 SBSA wheels)

> Do **not** run the extension's stock `setup.py` on Jetson; its ARM64 branch installs
> generic server-ARM (SBSA) `torch 2.5.1+cu124` wheels that **do not contain `sm_87`
> kernels**. They import fine and report `cuda available: True`, but the first real
> kernel throws `RuntimeError: CUDA error: no kernel image is available for execution on the device`.

Install from the jetson-ai-lab index instead (pick the channel matching your JetPack:
`jp6/cu126` for JetPack 6.2):

```bash
"$EXT/venv/bin/pip" install --no-deps \
  --index-url https://pypi.jetson-ai-lab.io/jp6/cu126 \
  torch==2.8.0 torchvision==0.23.0
```

> **Do not add `--extra-index-url https://pypi.org/simple` here.** pip will prefer the
> newer PyPI `torch` (e.g. 2.12 with a CUDA-13 dependency stack) which needs a CUDA-13
> driver JetPack 6.2 doesn't have. Keep it to the jetson-ai-lab index only.
> Other available pairings on that index: torch `2.9.1`/`2.10.0`/`2.11.0` ↔
> torchvision `0.24.1`/`0.25.0`/`0.26.0`.

### 4b. Install the rest of the dependencies, pinned for NumPy 1.x

The Jetson torch wheel is built against NumPy 1.x. Under NumPy 2 you get
`RuntimeError: Numpy is not available` from `torch.from_numpy` (the diffusion scheduler
uses it during model load). Pin NumPy `<2` and an OpenCV build that allows it:

```bash
"$EXT/venv/bin/pip" install \
  Pillow "numpy==1.26.4" trimesh pymeshlab "opencv-python-headless==4.10.0.84" \
  huggingface_hub "diffusers>=0.31.0" "transformers>=4.46.0" accelerate \
  einops scipy scikit-image
```

> `rembg` / `onnxruntime` are intentionally **omitted**; see §4c.

### 4c. Bypass `rembg` / ONNX Runtime (background removal)

ONNX Runtime is unusable on this Tegra CPU. The generic PyPI `aarch64` wheel aborts on
import/inference with:

```
onnxruntime cpuid_info warning: Unknown CPU vendor. cpuinfo_vendor value: 0
Assertion '__n < this->size()' failed.
```

and the jetson-ai-lab `onnxruntime-gpu` build segfaults during inference. Because these
are native C++ aborts (not Python exceptions), the extension's `try/except` fallback
can't catch them, so the whole subprocess dies (*"Subprocess died during generation"*).

`rembg` is only used for background removal in `_preprocess`. Replace it with a
dependency-free NumPy/SciPy remover. Save this as `patch_preprocess.py`:

```python
import re, sys
GEN = sys.argv[1]
src = open(GEN, encoding="utf-8").read()
NEW = '''    def _preprocess(self, image_bytes: bytes) -> Image.Image:
        # rembg/onnxruntime is unusable on Jetson's Tegra CPU; use a
        # dependency-free background remover (numpy + scipy, no onnxruntime).
        import numpy as np
        img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
        arr = np.array(img)
        if arr.shape[2] == 4 and int(arr[..., 3].min()) < 250:
            return img  # already has an alpha cutout
        rgb = arr[..., :3].astype(np.float32)
        h, w = rgb.shape[:2]
        b = max(2, min(h, w) // 50)
        border = np.concatenate([
            rgb[:b, :, :].reshape(-1, 3), rgb[-b:, :, :].reshape(-1, 3),
            rgb[:, :b, :].reshape(-1, 3), rgb[:, -b:, :].reshape(-1, 3),
        ], axis=0)
        bg = np.median(border, axis=0)
        dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
        thr = max(25.0, float(np.percentile(dist, 35)))
        alpha = (dist > thr).astype(np.uint8) * 255
        try:
            from scipy import ndimage
            lbl, n = ndimage.label(alpha > 0)
            if n > 1:
                sizes = ndimage.sum(np.ones_like(lbl), lbl, range(1, n + 1))
                keep = int(np.argmax(sizes)) + 1
                alpha = np.where(lbl == keep, 255, 0).astype(np.uint8)
            alpha = ndimage.binary_fill_holes(alpha > 0).astype(np.uint8) * 255
        except Exception:
            pass
        out = arr.copy()
        out[..., 3] = alpha
        return Image.fromarray(out, "RGBA")

'''
pat = re.compile(r"    def _preprocess\(self, image_bytes: bytes\) -> Image\.Image:.*?(?=\n    def )", re.DOTALL)
assert pat.search(src), "_preprocess block not found"
open(GEN, "w", encoding="utf-8").write(pat.sub(NEW.rstrip("\n") + "\n", src, count=1))
print("patched")
```

Apply it (a backup is kept):

```bash
cp -n "$EXT/generator.py" "$EXT/generator.py.orig"
python3 patch_preprocess.py "$EXT/generator.py"
"$EXT/venv/bin/python" -c "import ast; ast.parse(open('$EXT/generator.py').read()); print('parses OK')"
```

> **Caveat:** this remover is a simple border-colour key + largest-blob + hole-fill. It
> works well on clean/plain backgrounds (product shots, objects on a wall/floor) but
> poorly on busy scenes. A proper fix would be a working Jetson ONNX Runtime, or making
> background removal optional in the extension.

### 4d. Verify the GPU actually runs a kernel

```bash
"$EXT/venv/bin/python" - <<'PY'
import numpy as np, torch
print("torch", torch.__version__, "| cuda", torch.cuda.is_available(),
      "| dev", torch.cuda.get_device_name(0), "| cap", torch.cuda.get_device_capability(0))
a = torch.randn(512, 512, device="cuda", dtype=torch.float16)
print("matmul OK:", float((a @ a).float().sum()))
print("from_numpy OK:", torch.from_numpy(np.arange(3, dtype="float32")).cuda().sum().item())
PY
```

Expect `cap (8, 7)`, a finite `matmul OK`, and `from_numpy OK: 3.0`. If `matmul`
fails with *"no kernel image"*, your torch wheel is wrong (see 4a). If `from_numpy`
fails, NumPy is ≥2 (see 4b).

---

## 5. Run the backend (headless)

```bash
cd ~/modly/api
EXTENSIONS_DIR=$HOME/.modly/extensions \
MODELS_DIR=$HOME/.modly/models \
WORKSPACE_DIR=$HOME/.modly/workspace \
./.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
```

> Optional: `export HF_TOKEN=hf_...` before launching to avoid HuggingFace rate-limits
> on the one-time ~4 GB weight download.

Check it (from the Jetson, or from another machine using the Jetson's IP):

```bash
curl http://127.0.0.1:8000/health        # {"status":"ok"}
curl http://127.0.0.1:8000/model/all     # lists hunyuan3d-mini/generate
curl http://127.0.0.1:8000/extensions/errors   # {} == no load errors
```

---

## 6. Generate a mesh

```bash
# Submit (first run downloads weights + hy3dgen, then loads on CUDA)
curl -s -X POST http://127.0.0.1:8000/generate/from-image \
  -F image=@your_object.png \
  -F model_id=hunyuan3d-mini/generate \
  -F remesh=none -F enable_texture=false \
  -F 'params={"num_inference_steps":50,"octree_resolution":512,"guidance_scale":5.5,"seed":42}'
# -> {"job_id":"..."}

# Poll until "done"
curl http://127.0.0.1:8000/generate/status/<job_id>

# The result is served from the workspace; download it
curl -O http://127.0.0.1:8000/workspace/Default/<file>.glb
```

`params` options for this model: `num_inference_steps` (10/30/50),
`octree_resolution` (256/380/512; higher = more detail + VRAM), `guidance_scale`,
`seed`. A 64 GB Orin handles `50 / 512` comfortably.

---

## 7. Performance: max out the Orin

A fresh Jetson is often in a power-limited `nvpmodel` (fewer CPU cores, lower clocks),
which slows the CPU-bound model-load and pre/post-processing. For full speed:

```bash
sudo nvpmodel -m 0     # MAXN (all cores)
sudo jetson_clocks     # lock max clocks
```

Watch utilisation during a run with `tegrastats` (expect `GR3D_FREQ` near 100% during
diffusion).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `CUDA error: no kernel image is available for execution on the device` | torch wheel has no `sm_87` kernels (generic SBSA build) | Install Jetson torch from jetson-ai-lab (§4a) |
| `RuntimeError: Numpy is not available` (in `from_numpy`) | torch built against NumPy 1.x, but NumPy ≥2 installed | `pip install "numpy==1.26.4"` + OpenCV `4.10.0.84` (§4b) |
| `Subprocess died during generation` at *"Removing background"*; log shows `Unknown CPU vendor` / `Assertion '__n < this->size()'` / segfault | ONNX Runtime broken on Tegra CPU | Patch `_preprocess` to drop `rembg` (§4c) |
| `opencv-python-headless ... requires numpy>=2` | newer OpenCV forces NumPy 2 | pin `opencv-python-headless==4.10.0.84` |
| Edits to the extension venv don't take effect | the backend keeps a long-lived extension subprocess that survives errors | restart the backend so it respawns the subprocess |

---

## Known limitations

- **No textures.** This guide covers mesh-only generation. `enable_texture=true`
  requires building `custom_rasterizer` and `differentiable_renderer` (CUDA C++
  extensions) from source for `aarch64`, not covered here.
- **Background removal is approximate** (see §4c caveat).
- Single-image 3D infers unseen sides; the back/underside are model guesses. Output
  meshes are typically not watertight.

---

## Notes for a proper upstream fix

If Modly wants first-class Jetson support, the cleanest changes would be:

1. In the extension `setup.py`, detect Tegra (`/etc/nv_tegra_release`) and install torch
   from the jetson-ai-lab index for the detected JetPack/CUDA, pinning `numpy<2`.
2. Make background removal pluggable / optional, or ship a non-ONNX fallback, so a broken
   ONNX Runtime can't hard-crash generation.
3. Document the headless backend (`uvicorn main:app` + the three env vars) as a supported
   way to run generation without Electron.
