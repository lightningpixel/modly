# Running Modly on an AMD GPU (ROCm)

Modly's default GPU path is NVIDIA/CUDA (plus Metal/MPS on Apple Silicon). This page
covers the AMD path: how Modly detects a Radeon card, which PyTorch wheels it steers
extensions to, and what to do when the automatic choice is wrong.

Nothing here needs a manual setup: install the app, install an extension, and the AMD
path is taken automatically when an AMD GPU is present.

---

## 1. Requirements

| | Linux | Windows |
|---|---|---|
| GPU | RDNA 2 or newer discrete Radeon (see the table below) | same |
| Driver | in-tree `amdgpu` kernel driver — any recent distro kernel | Adrenalin with the ROCm runtime (26.2.2 or newer) |
| ROCm install | **not required** — the PyTorch ROCm wheels bundle their own runtime | not required |
| Device access | `/dev/kfd` and `/dev/dri/renderD*` must be readable by your user | n/a |

On most distributions `/dev/kfd` is world-accessible. If it is not, add yourself to the
`render` group and log back in:

```bash
ls -l /dev/kfd            # crw-rw-rw- → nothing to do
sudo usermod -aG render "$USER"
```

Integrated (APU) graphics are not mapped by the Windows detection table. They work on
Linux whenever the kernel publishes a compute target, but they are not a target Modly
tests against.

---

## 2. How detection works

Detection lives in `electron/main/gpu-detect.ts` and runs before an extension's
`setup.py`, in this order:

1. `MODLY_TORCH_FLAVOR` (`cuda` / `rocm` / `cpu`) — an explicit override wins over everything.
2. Apple Silicon → MPS.
3. `nvidia-smi` → CUDA. **NVIDIA keeps priority**: on a machine with both vendors,
   nothing about the existing CUDA behaviour changes.
4. AMD:
   - **Linux** — reads `gfx_target_version` from the kernel's KFD topology
     (`/sys/class/kfd/kfd/topology/nodes/*/properties`). No ROCm install and no external
     binary involved; the `amdgpu` driver publishes this on its own.
   - **Windows** — reads the PCI device id from `Win32_VideoController` via PowerShell
     and maps it to a compute target.
5. Otherwise → CPU.

You can check what was detected in the logs (Settings → Logs), on the line beginning
`[ext-setup] accelerator=`:

```
[ext-setup] accelerator=rocm gfx=gfx1200 torch_index=https://download.pytorch.org/whl/rocm7.2
```

### Supported compute targets

| Silicon | Compute target | Cards |
|---|---|---|
| Navi 44 | `gfx1200` | RX 9060 XT |
| Navi 48 | `gfx1201` | RX 9070, RX 9070 XT, RX 9070 GRE, AI PRO R9700 |
| Navi 31 | `gfx1100` | RX 7900 XT/XTX/GRE, PRO W7800/W7900 |
| Navi 32 | `gfx1101` | RX 7700 XT, RX 7800 XT, PRO W7700 |
| Navi 33 | `gfx1102` | RX 7600 series, PRO W7500/W7600 |
| Navi 21 | `gfx1030` | RX 6800/6800 XT/6900 XT/6950 XT, PRO W6800 |
| Navi 22/23/24 | `gfx1031` / `gfx1032` / `gfx1034` | RX 6700 / 6600 / 6400 series |

On Linux the target is read from the kernel, so any AMD GPU the kernel knows about is
picked up — the table above only bounds the *Windows* mapping. AMD officially supports
`gfx1030`, `gfx110x` and `gfx120x`; the RDNA 2 mid-range entries work in practice but
are not part of AMD's supported matrix.

---

## 3. Which wheels get installed

Modly does not install PyTorch itself — each extension's `setup.py` does, from an index
it hardcodes. On an AMD machine Modly corrects that choice two ways:

- It passes `torch_flavor: "rocm"` in the setup arguments. Extensions that know about
  AMD (the official `hunyuan3d-mini` one does) branch on it themselves.
- For every extension that doesn't, a compatibility shim in the setup launcher rewrites
  the pip command: the CUDA (or CPU) index is swapped for the ROCm one, and the pinned
  `torch==…` requirements are replaced. Non-torch installs are left untouched.

| Platform | Index | Requirements |
|---|---|---|
| Linux | `https://download.pytorch.org/whl/rocm7.2` | `torch`, `torchvision`, unpinned |
| Windows | `https://repo.amd.com/rocm/whl-multi-arch/` | `torch[device-gfxNNNN]==2.11.0+rocm7.14.0` and matching `torchvision` |

The two differ because `download.pytorch.org` publishes no ROCm wheels for Windows at
all. AMD's multi-arch index does, and there the compute target is selected by a pip
extra rather than by the index URL.

`sm` and `cuda_version` are deliberately reported as `0` for AMD. Extensions written
before `torch_flavor` existed branch on those numbers, and `0` sends them down their
most conservative path — which also keeps them off `rembg[gpu]`, whose `onnxruntime-gpu`
is CUDA-only.

---

## 4. Verifying an install

After installing an extension (or running **Repair** on it from the Models page), check
what actually landed in its venv:

```bash
# Linux; adjust to your extensions directory
EXT=~/Documents/Modly/extensions/hunyuan3d-mini
"$EXT/venv/bin/python" -c "import torch; print(torch.__version__, '| hip', torch.version.hip, '| avail', torch.cuda.is_available(), '|', torch.cuda.get_device_name(0))"
```

Expected: a `+rocm…` version, a non-null `hip`, `True`, and your card's name. A version
ending in `+cu118` or `+cu124` means the AMD path was not taken — check the detection
line in the logs.

Then confirm real VRAM is usable, not just that the device opens:

```bash
"$EXT/venv/bin/python" -c "import torch; x = torch.empty(5_000_000_000, dtype=torch.float16, device='cuda'); torch.cuda.synchronize(); print('10 GB allocated OK')"
```

---

## 5. Escape hatches

All of these are environment variables read at detection time — set them before
launching Modly.

| Variable | Effect |
|---|---|
| `MODLY_TORCH_FLAVOR` | `cuda` / `rocm` / `cpu`. Forces the path, skipping detection entirely. |
| `MODLY_ROCM_GFX` | Forces the compute target (e.g. `gfx1201`). Needed for an AMD card the Windows table doesn't map. |
| `MODLY_ROCM_INDEX` | Overrides the pip index, e.g. `https://download.pytorch.org/whl/rocm6.4` to fall back to torch 2.8/2.9. |
| `MODLY_ROCM_TORCH_SPEC` | Overrides the requirements entirely, space-separated: `"torch==2.9.1 torchvision==0.24.1"`. |
| `HSA_OVERRIDE_GFX_VERSION` | ROCm's own override, for cards without native kernels (e.g. `10.3.0` on an unsupported RDNA 2 part). Not needed on RDNA 3/4. |

After changing any of these, run **Repair** on the extension so its venv is rebuilt.

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Logs say `accelerator=cpu` on an AMD machine | `/dev/kfd` missing or unreadable (Linux), or an unmapped PCI id (Windows) | Check `ls -l /dev/kfd`; on Windows set `MODLY_ROCM_GFX` |
| `torch.__version__` ends in `+cu118` | Extension venv predates AMD support | Run **Repair** on the extension |
| `torch.cuda.is_available()` is `False` with a ROCm build | Device nodes not accessible from the process | Add your user to the `render` group, log back in |
| `HIP error: invalid device function` | Wheel has no kernels for your card | Set `HSA_OVERRIDE_GFX_VERSION` to a supported nearby target |
| Extension imports fail after install (`diffusers`/`transformers`) | The ROCm index only carries recent torch (2.11+), newer than some extensions expect | `MODLY_ROCM_INDEX=https://download.pytorch.org/whl/rocm6.4`, then **Repair** |
| Allocations above ~8 GB segfault on a 16 GB RX 9060 XT | [ROCm issue #6295](https://github.com/ROCm/ROCm/issues/6295) — did not reproduce on torch 2.13.0+rocm7.2 (see below) | If you hit it, pin an older stack via `MODLY_ROCM_INDEX` |

---

## 7. Verified configuration and limitations

The Linux path was measured end to end on a Radeon RX 9060 XT (Navi 44, gfx1200,
16 GB), CachyOS kernel 7.1.8, with the stack this page installs by default:

- `torch 2.13.0+rocm7.2` / `torchvision 0.28.0+rocm7.2`, HIP runtime 7.2.53211
- Detection reported `gfx1200`; `torch.cuda.is_available()` is `True` and
  `get_device_properties(0).gcnArchName` is `gfx1200`
- rocBLAS (fp16 matmul) and MIOpen (conv2d) kernels both execute — no
  `no kernel image is available` failures
- Allocations of 4/6/8/10/12/14 GB all succeeded, filled and read back.
  [ROCm #6295](https://github.com/ROCm/ROCm/issues/6295), which reports this exact
  card capped near 8 GB with a segfault, **did not reproduce** on this stack.
  It remains open upstream, so it may still affect older ROCm builds.
- A full image-to-3D generation with `hunyuan3d-mini` completed through the normal
  `ExtensionProcess` subprocess path: model load 18 s, generation 221 s, 15.8 MB GLB.

### Attention kernels

During generation PyTorch emits:

> Mem Efficient attention on Current AMD GPU is still experimental. Enable it with
> `TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1`

Generation works without it — `scaled_dot_product_attention` falls back to a
slower path. Setting `TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL=1` before launching
Modly enables the memory-efficient kernels, at the cost of running code AMD still
labels experimental on RDNA 3/4. Modly does not set it for you.

Limitations:

- **Windows is untested** by the Modly maintainers. The wheel URLs and the `cp311`
  availability were verified, but no end-to-end run has been done on that path.
- **Texture generation** relies on optional native extensions (`texture_baker`,
  `uv_unwrapper`) whose CUDA kernels have a HIP path but are not built as part of the
  standard extension setup.
