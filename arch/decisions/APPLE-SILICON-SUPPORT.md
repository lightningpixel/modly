# APPLE-SILICON-SUPPORT

- Status: proposed
- Date: 2026-04-23

## Decision

Modly supports macOS on Apple Silicon (`darwin/arm64`) as a first-class
platform. This ADR consolidates the runtime, packaging, extension, and
workflow rules needed to run the image-to-mesh pipeline reliably on 16 GB
unified-memory Macs.

Scope and operating rules:

- macOS support targets Apple Silicon only. See `package.json:99`.
- Intel macOS, universal binaries, and Rosetta fallback are out of scope.
- Model weights stay separate from extension code and are installed per node. See `api/routers/model.py:76` and `api/runner.py:101`.
- The Mac workflow is sequential and memory-budgeted: one heavy generative
  stage resident at a time. See `src/areas/workflows/workflowRunStore.ts:185`.
- Download/install state must be observable and resumable. See `electron/main/model-downloader.ts:116`.
- Releasing GPU memory means terminating the owning subprocess. See `api/services/extension_process.py:205` and `electron/main/index.ts:105`.
- Generation progress and cancel behavior must remain visible and responsive in
  the UI. See `api/services/extension_process.py:135` and `src/areas/workflows/workflowRunStore.ts:232`.

## Context

Apple Silicon changes the constraints under which Modly runs:

- Unified memory means overlapping heavy GPU stages can destabilize the whole
  machine on 16 GB systems.
- Metal/MPS memory is not returned predictably by Python-side cleanup alone;
  process exit is the reliable release boundary.
- Large model downloads need byte-level visibility, stall detection, and proper
  resume behavior to avoid appearing hung or silently reinstalling from zero.
- Extension manifests now need per-node distribution metadata because one
  extension can expose multiple model variants that share code but differ in
  weights, defaults, and required artifacts.
- Workflow graphs need preflight validation before execution so invalid wiring
  is reported without replacing the current mesh view with a terminal error
  state.
- The renderer needs progress text that stays live through long native phases
  and a cancel path that clears UI state immediately even if backend teardown
  takes longer.

## Consequences

- Packaging:
  Modly packages macOS as an Apple Silicon build path only, including the
  embedded Python runtime in the app bundle. See `package.json:99`.

- Extension and model distribution:
  Extension payloads contain code, manifests, setup scripts, and lightweight
  assets. Model nodes declare their own `download_check`, can narrow downloads
  with `hf_include_prefixes` and `hf_skip_prefixes`, and may provide
  node-specific `params_schema` and `param_defaults` with top-level fallback.
  See `api/routers/model.py:76`, `api/runner.py:84`, and
  `electron/main/model-downloader.ts:116`.

- Runtime selection and defaults:
  The runner resolves the active node from `MODEL_DIR` so multi-node extensions
  use the correct schema, model directory, and node-specific metadata. Workflow
  submission merges displayed parameter defaults under user overrides before the
  request reaches Python. See `api/runner.py:84` and
  `src/areas/workflows/workflowRunStore.ts:207`.

- Mesh optimization path handling:
  Smooth and decimate operations accept both workspace-relative meshes and
  imported absolute-path meshes, then write optimized output back into the
  workspace so the result remains visible and reusable in the app. See
  `api/routers/optimize.py:42` and `src/areas/generate/GeneratePage.tsx:331`.

- Memory-budgeted workflow:
  Heavy stages hand off through files and unload before the next heavy stage
  begins. CPU-oriented stages can run between GPU-heavy stages without
  competing for MPS residency. See `electron/main/index.ts:105`,
  `api/services/extension_process.py:214`, and
  `src/areas/workflows/workflowRunStore.ts:142`.

- Download behavior:
  The downloader emits byte-level progress, file context, and stall state.
  Partial downloads are preserved as `.part` files. Resume is attempted against
  the resolved final URL so `Range` works even when upstream redirects to a CDN.
  Install completion is verified by the declared `download_check`, not by
  directory existence alone. See `electron/main/model-downloader.ts:10`,
  `electron/main/model-downloader.ts:31`, and `api/routers/model.py:84`.

- Subprocess lifecycle:
  Extension subprocesses are owned as a full process tree. On Unix, the Python
  bridge runs as its own process-group leader and Modly kills the process group
  on quit. Free-memory/unload operations hard-stop the subprocess. Cancel first
  sends a cooperative request, then escalates to a kill after a short grace
  period if native code is still blocking. See `api/services/extension_process.py:78`
  and `electron/main/index.ts:112`.

- Observability and UX:
  Generator stderr stays available for tqdm-style progress parsing, long phases
  surface readable status text, and cancel clears renderer job state
  immediately. Workflow editors run a preflight pass before execution and
  surface wiring problems through inline warnings and toasts instead of
  replacing the current mesh view. Error output in the HUD remains
  copyable/selectable. The top bar includes a live RAM indicator backed by a
  main-process `system:memory` IPC call; macOS uses `vm_stat` to approximate
  Activity Monitor's "Memory Used" semantics and other platforms fall back to
  `total - free`. macOS uses native window controls instead of custom
  right-side controls. See
  `api/services/extension_process.py:135`,
  `src/areas/workflows/preflight.ts:51`,
  `src/areas/generate/components/WorkflowPanel.tsx:425`,
  `src/areas/workflows/WorkflowsPage.tsx:847`,
  `src/shared/components/ui/Toast.tsx:4`,
  `electron/main/ipc-handlers.ts:372`,
  `src/shared/components/layout/MemoryIndicator.tsx:9`,
  `src/shared/components/layout/TopBar.tsx:4`, and
  `src/areas/setup/FirstRunSetup.tsx:258`.
