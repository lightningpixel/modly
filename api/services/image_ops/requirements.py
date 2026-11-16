"""Things image ops install on first use: a pip package, a model file.

Neither is in api/requirements.txt on purpose: changing that file sends every
user through a full venv reinstall (electron/main/python-setup.ts), for a
feature many will never open. They are fetched the first time the op is
prepared, into the backend's own environment and MODELS_DIR.
"""

import hashlib
import importlib
import importlib.util
import os
import subprocess
import sys
import threading
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional

from .types import ImageOpExecutionError, ProgressCallback


def _models_dir() -> Path:
    # Read at call time: POST /settings/paths rebinds it when the user moves it.
    import services.generator_registry as registry
    return registry.MODELS_DIR


def _hf_offline() -> bool:
    return os.environ.get("HF_HUB_OFFLINE", "").strip().lower() in ("1", "true", "yes", "on")


# ─── pip package ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class PipPackageRequirement:
    """A Python package pip-installed into the running interpreter's environment."""

    id: str              # pip / import name, e.g. "onnxruntime"
    label: str
    pip_spec: str        # e.g. "onnxruntime==1.23.2"
    approx_bytes: int    # wheel + dependencies, for the status estimate
    kind: str = "runtime"
    module: Optional[str] = None  # import name when it differs from `id`

    @property
    def module_name(self) -> str:
        return self.module or self.id

    def is_ready(self) -> bool:
        return importlib.util.find_spec(self.module_name) is not None

    def download_bytes(self) -> Optional[int]:
        return None if self.is_ready() else self.approx_bytes

    def install(self, progress: ProgressCallback) -> None:
        if self.is_ready():
            progress({"percent": 100, "status": f"{self.label} already installed"})
            return

        progress({"percent": 0, "status": f"Installing {self.label}…"})
        command = [
            sys.executable, "-m", "pip", "install", self.pip_spec,
            "--disable-pip-version-check", "--no-input",
            "--no-warn-script-location", "--progress-bar", "off",
        ]
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if sys.platform == "win32" else 0
        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=creationflags,
            )
        except OSError as exc:
            raise ImageOpExecutionError(f"Could not start pip to install {self.label}: {exc}") from exc

        # pip prints no byte counts with the progress bar off: advance on its
        # phase lines so the bar moves, and keep the tail for the error message.
        tail: deque[str] = deque(maxlen=12)
        percent = 0
        assert process.stdout is not None
        for raw in process.stdout:
            line = raw.strip()
            if not line:
                continue
            tail.append(line)
            if line.startswith("Collecting "):
                percent = min(60, percent + 8)
            elif line.startswith("Downloading "):
                percent = min(70, percent + 4)
            elif line.startswith("Installing collected packages"):
                percent = 80
            else:
                continue
            progress({"percent": percent, "status": f"Installing {self.label}… {line[:80]}"})
        code = process.wait()

        if code != 0:
            detail = " | ".join(line for line in tail if "error" in line.lower()) or " | ".join(list(tail)[-3:])
            hint = ""
            if any(token in detail.lower() for token in ("connection", "network", "resolve", "proxy", "timed out", "no matching distribution")):
                hint = " Check your internet connection and try again."
            raise ImageOpExecutionError(
                f"Installing {self.label} failed (pip exited with code {code}).{hint} {detail}".strip()
            )

        importlib.invalidate_caches()
        if not self.is_ready():
            raise ImageOpExecutionError(f"{self.label} was installed but cannot be found by Python")
        try:
            importlib.import_module(self.module_name)
        except Exception as exc:  # broken wheel, missing system library…
            raise ImageOpExecutionError(f"{self.label} was installed but fails to load: {exc}") from exc
        progress({"percent": 100, "status": f"{self.label} installed"})


# ─── Hugging Face model file ──────────────────────────────────────────────────

@dataclass(frozen=True)
class HFFileRequirement:
    """One model file downloaded from a pinned Hugging Face revision into
    <MODELS_DIR>/<id>/<local_name>, verified by size and SHA-256."""

    id: str              # also the folder name under MODELS_DIR
    label: str
    repo_id: str
    filename: str        # path inside the repo
    revision: str        # pinned commit
    size: int
    sha256: str
    local_name: str = "model.onnx"
    kind: str = "model"

    @property
    def path(self) -> Path:
        return _models_dir() / self.id / self.local_name

    def is_ready(self) -> bool:
        try:
            return self.path.is_file() and self.path.stat().st_size == self.size
        except OSError:
            return False

    def download_bytes(self) -> Optional[int]:
        """Bytes left to fetch; a resumable .part file counts as already fetched."""
        if self.is_ready():
            return None
        part = self.path.with_suffix(self.path.suffix + ".part")
        try:
            done = part.stat().st_size if part.is_file() else 0
        except OSError:
            done = 0
        return max(0, self.size - done)

    def install(self, progress: ProgressCallback) -> None:
        if self.is_ready():
            progress({"percent": 100, "status": f"{self.label} already downloaded"})
            return
        if _hf_offline():
            raise ImageOpExecutionError(
                f"{self.label} is not downloaded and HF_HUB_OFFLINE is set; go online once to fetch it"
            )

        from huggingface_hub import hf_hub_url
        from routers.model import _download_file_streamed

        target = self.path
        # A complete-looking file of the wrong size (interrupted copy, older
        # revision) would be returned as-is by the downloader: start clean.
        if target.exists():
            target.unlink()

        def _on_progress(msg: dict) -> None:
            done = msg.get("bytesDownloaded") or 0
            total = msg.get("totalBytes") or self.size
            pct = min(99, round(done / total * 100)) if total else 0
            progress({
                "percent": pct,
                "status": f"Downloading {self.label}… {pct}%"
                if str(msg.get("status", "")).startswith(("Downloading", "Resuming"))
                else str(msg.get("status") or f"Downloading {self.label}…"),
                "bytesDownloaded": done,
                "totalBytes": total,
            })

        control = {"pause": threading.Event(), "cancel": threading.Event()}
        try:
            _download_file_streamed(
                url=hf_hub_url(repo_id=self.repo_id, filename=self.filename, revision=self.revision),
                filename=self.local_name,
                dest_dir=str(target.parent),
                file_index=1,
                total_files=1,
                base_percent=0,
                progress_cb=_on_progress,
                control=control,
            )
        except Exception as exc:
            # The downloader wraps network failures (after its retries) in
            # RuntimeError; a bare OSError here is local (disk full, permissions).
            hint = "" if isinstance(exc, OSError) else " Check your internet connection and try again."
            raise ImageOpExecutionError(f"Downloading {self.label} failed: {exc}.{hint}") from exc

        progress({"percent": 99, "status": f"Verifying {self.label}…"})
        digest = _sha256(target)
        if target.stat().st_size != self.size or digest != self.sha256:
            target.unlink(missing_ok=True)
            raise ImageOpExecutionError(f"{self.label} download is corrupted (checksum mismatch); try again")
        progress({"percent": 100, "status": f"{self.label} ready", "bytesDownloaded": self.size, "totalBytes": self.size})


def _sha256(path: Path, chunk: int = 4 * 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()


# ─── The concrete requirements ────────────────────────────────────────────────

# 1.23.2 is the newest onnxruntime with CPU wheels for every platform Modly runs
# on: win_amd64, macOS arm64 *and* x86_64 (1.24 dropped Intel Macs), manylinux
# x86_64/aarch64, for CPython 3.10–3.13 including the bundled 3.11.
ONNXRUNTIME = PipPackageRequirement(
    id="onnxruntime",
    label="ONNX Runtime",
    pip_spec="onnxruntime==1.23.2",
    approx_bytes=25_000_000,
)

# BiRefNet-lite (MIT), fp32 ONNX export. fp16 halves the download but CPU
# execution of fp16 graphs in onnxruntime is slower and less accurate.
BIREFNET_LITE = HFFileRequirement(
    id="birefnet-lite",
    label="BiRefNet-lite model",
    repo_id="onnx-community/BiRefNet_lite-ONNX",
    filename="onnx/model.onnx",
    revision="de15b22ba131738a16dff04aab8bdf8dc32e3ac1",
    size=224_005_088,
    sha256="5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333",
)
