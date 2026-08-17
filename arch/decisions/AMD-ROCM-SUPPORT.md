# AMD-ROCM-SUPPORT

- Status: proposed
- Date: 2026-08-17

## Decision

Modly supports AMD Radeon GPUs through ROCm on Linux and Windows. Detection is
automatic and requires no ROCm installation on the user's machine.

Scope and operating rules:

- Detection is centralised in `electron/main/gpu-detect.ts` and produces, for AMD
  machines, a compute target plus the pip index and requirements an extension's
  torch install must end up using.
- NVIDIA keeps detection priority. On a machine with both vendors the existing
  CUDA behaviour is unchanged.
- AMD machines report `gpu_sm = 0` and `cuda_version = 0`, never a synthesised
  compute capability.
- Extensions are told the flavour via a `torch_flavor` setup argument. Extensions
  that ignore it are corrected by a rewrite shim in `electron/main/setup-launcher.ts`.
- The ROCm wheel source differs by platform: `download.pytorch.org/whl/rocm7.2`
  on Linux, `repo.amd.com/rocm/whl-multi-arch/` on Windows.
- Every automatic choice has an environment-variable override. See
  `docs/running-on-amd-rocm.md`.

## Context

Modly never installs PyTorch itself. Each extension ships a `setup.py` that
creates its own venv and installs torch from an index it hardcodes — and those
scripts are third-party code in separate GitHub repositories that Modly cannot
edit. Before this work `detectGpuInfo()` only probed `nvidia-smi`, so an AMD
machine was reported as `accelerator: 'cpu'` with `gpu_sm: 0`, which sent every
extension down its legacy CUDA 11.8 branch and installed a torch that cannot see
the GPU at all.

That leaves two distinct problems, and both have to be solved:

- Extensions that *do* understand AMD were never told. The official
  `modly-hunyuan3d-mini-extension` has accepted a `torch_flavor: "rocm"` argument
  for some time; Modly simply never sent it.
- Extensions that don't understand AMD — `triposg`, `trellis2`, and the rest —
  hardcode `--index-url .../whl/cu124` and have no branch to select. Passing an
  argument achieves nothing for them.

The wheel sources are also not symmetric across platforms. `download.pytorch.org`
publishes no ROCm wheels for Windows at all; AMD's own multi-arch index does, but
there the compute target is selected by a pip extra (`torch[device-gfx1200]`)
rather than by the index URL, which means Windows needs the compute target
*before* the install, not after.

## Consequences

- **A rewrite shim is unavoidable.** Correcting extensions we cannot edit means
  intercepting their pip calls. The launcher already patched `subprocess` for two
  other compatibility fixes, so ROCm redirection joins those rather than
  introducing a new mechanism.
- **The decision is made in TypeScript, applied in Python.** The launcher is an
  inline Python string that cannot be unit-tested in isolation, so index and
  requirement resolution lives in `gpu-detect.ts` and reaches the launcher as
  environment variables. The launcher is separately exercised end-to-end by
  `setup-launcher.test.mjs`, which runs it against the command shapes the
  official extensions actually use.
- **`gpu_sm = 0` is load-bearing, not a placeholder.** Extensions written before
  `torch_flavor` branch on that number, and 0 selects their most conservative
  path. It also keeps them off `rembg[gpu]`, whose `onnxruntime-gpu` is
  CUDA-only. Reporting a synthesised capability instead would break both.
  PyTorch's HIP build answers the whole `torch.cuda` API, so
  `get_device_capability()` reports `(12, 0)` for a gfx1200 Radeon —
  indistinguishable from an sm_120 Blackwell. `api/routers/extensions.py` guards
  on `torch.version.hip` for this reason.
- **Compute-target discovery is platform-specific.** Linux reads
  `gfx_target_version` from the kernel's KFD topology, which needs no ROCm
  install and no external binary. Windows has no equivalent, so it maps PCI
  device ids from `Win32_VideoController` through a table keyed by silicon. That
  table is a maintenance surface: new AMD silicon needs an entry, and an unmapped
  AMD card falls back to CPU with an actionable message rather than guessing a
  wheel.
- **The Linux and Windows torch versions diverge.** Linux gets unpinned wheels
  from the pytorch.org ROCm index (currently torch 2.11+); Windows gets a pinned
  pair from AMD's index. Extension code written against torch 2.6/2.7 may not
  survive that jump, which is why `MODLY_ROCM_INDEX` and `MODLY_ROCM_TORCH_SPEC`
  exist as first-class escape hatches rather than debug affordances.
- **Linux is verified, Windows is not.** On a Radeon RX 9060 XT (gfx1200),
  `torch 2.13.0+rocm7.2` loads, rocBLAS and MIOpen kernels execute, 14 GB of the
  card's 16 GB allocates and reads back cleanly ([ROCm #6295](https://github.com/ROCm/ROCm/issues/6295),
  which reports this card capped near 8 GB, did not reproduce), and a full
  image-to-3D generation completes through the normal `ExtensionProcess` path in
  221 s. For Windows the wheel URLs, `cp311` availability and index layout were
  checked, but no end-to-end run has been performed.
- **This work also required fixing an unrelated AppImage bug** to be verifiable
  at all. `ensureStableEmbeddedPython()` copied the bundled runtime with
  `fs.cp`, which rewrites relative symlinks into absolute paths pointing back at
  the ephemeral `/tmp/.mount_Modly-XXXXXX/` mount — so the "stable" copy was not
  stable, and every extension venv built from it died on the next launch with a
  misleading `No module named 'PIL'`. See `electron/main/copy-runtime.ts`.
- **Texture generation is out of scope.** `api/texture_baker` already carries a
  HIP build path, but those native extensions are not built as part of standard
  extension setup, so texture generation is not covered by this ADR.
