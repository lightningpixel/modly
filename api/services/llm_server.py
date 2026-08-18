"""
Local LLM engine — manages a llama.cpp `llama-server` subprocess.

Everything lives under the per-user directory ~/.modly/llm/:
  bin/     llama-server binary + DLLs (auto-downloaded from GitHub releases)
  models/  GGUF files (catalog downloads + any custom .gguf the user drops in)

Nothing is hardcoded to a machine: the binary variant is picked per-platform
(CUDA if an NVIDIA driver is present, otherwise Vulkan, otherwise CPU) and
models are chosen by the user from the catalog.
"""
import contextlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from pathlib import Path
from typing import Callable, Optional
from urllib.request import Request, urlopen
import json as _json

LLM_DIR        = Path(os.environ.get("MODLY_LLM_DIR") or Path.home() / ".modly" / "llm")
BIN_DIR        = LLM_DIR / "bin"
LLM_MODELS_DIR = LLM_DIR / "models"
LOGS_DIR       = LLM_DIR / "logs"
SERVER_PORT    = int(os.environ.get("MODLY_LLM_PORT", "8791"))

# Modly is first and foremost a 3D-generation app: the LLM must never sit on
# VRAM it isn't using. Idle models are evicted after this many seconds.
IDLE_TTL_SECONDS = int(os.environ.get("MODLY_LLM_IDLE_TTL", "300"))

# Multi-model pool: each loaded model gets its own llama-server process on its
# own port (SERVER_PORT .. SERVER_PORT+MAX_SLOT_PORTS-1). How many may run at
# once is user-configurable ("auto" sizes it from the GPU's VRAM — small cards
# stay at 1, exactly like the old single-slot behavior).
MAX_SLOT_PORTS = 4
CONFIG_PATH    = LLM_DIR / "config.json"

LLM_MODELS_DIR.mkdir(parents=True, exist_ok=True)


def load_config() -> dict:
    try:
        return _json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(_json.dumps(cfg, indent=2), encoding="utf-8")


_vram_gb_cache: Optional[float] = None


def detect_vram_gb() -> float:
    """Total VRAM of the first NVIDIA GPU in GiB (0.0 if none/unknown)."""
    global _vram_gb_cache
    if _vram_gb_cache is not None:
        return _vram_gb_cache
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10,
        ).stdout.strip().splitlines()
        _vram_gb_cache = round(float(out[0]) / 1024.0, 1) if out else 0.0
    except Exception:
        _vram_gb_cache = 0.0
    return _vram_gb_cache


def resolve_max_models() -> int:
    """How many llama-server processes may run at once.

    Priority: MODLY_LLM_MAX_MODELS env → user config → auto from VRAM.
    Auto is deliberately conservative: 8 GB cards keep the single-slot
    behavior, VRAM stays available for the 3D pipeline."""
    raw = os.environ.get("MODLY_LLM_MAX_MODELS") or load_config().get("max_models") or "auto"
    if isinstance(raw, str) and raw.lower() == "auto":
        # Thresholds sit just under the marketing size on purpose: a card sold
        # as "12 GB" reports 12227 MiB = 11.9 GiB, so a `>= 12` test excluded
        # every 12 GB card there is (5070, 4070, 3060 12G…) from the 2-slot
        # tier it was written for. Same story at 20 for a 20/24 GB card.
        vram = detect_vram_gb()
        n = 3 if vram >= 19.5 else 2 if vram >= 11.5 else 1
    else:
        try:
            n = int(raw)
        except (TypeError, ValueError):
            n = 1
    return max(1, min(n, MAX_SLOT_PORTS))

_BINARY_NAME = "llama-server.exe" if sys.platform == "win32" else "llama-server"
_UA          = {"User-Agent": "modly-llm"}

# Pinned to a known-good tag by default so installs are reproducible and never
# silently pick up a broken/incompatible "latest" release. Set MODLY_LLM_RELEASE
# to another llama.cpp tag (e.g. "b10075") to override, or to "latest" to track
# the newest release.
_RELEASE_TAG  = os.environ.get("MODLY_LLM_RELEASE", "b10075")
_RELEASES_API = (
    "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
    if _RELEASE_TAG.lower() == "latest"
    else f"https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/{_RELEASE_TAG}"
)

CATALOG_PATH = Path(__file__).resolve().parent.parent / "resources" / "llm_catalog.json"

DEFAULT_CTX = 16384
DEFAULT_NGL = 99


def load_catalog() -> list[dict]:
    return _json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


_FALLBACK_DEFAULT_MODEL = "qwen3-4b"

# What the agent sends when a catalog entry declares nothing of its own. Low
# temperature is what keeps small models from emitting malformed tool-call JSON.
_DEFAULT_SAMPLING = {"temperature": 0.2}


def sampling_for(model_id: str) -> dict:
    """Sampling parameters for one local model.

    Model families publish the settings they were tuned for, and ignoring them
    is not neutral: served at a flat temperature with no presence penalty, a
    Qwen 3.5 repeated the same lookup ten times in one turn and never acted.
    A catalog entry can therefore carry its own `sampling` block."""
    entry = next((e for e in load_catalog() if e["id"] == model_id), None)
    declared = (entry or {}).get("sampling") or {}
    return {**_DEFAULT_SAMPLING, **{k: v for k, v in declared.items() if v is not None}}


def default_model_id() -> str:
    """Catalog entry tagged "default", falling back to a known-good id if the
    catalog has no such tag (keeps old behavior if llm_catalog.json changes)."""
    for entry in load_catalog():
        if "default" in (entry.get("tags") or []):
            return entry["id"]
    return _FALLBACK_DEFAULT_MODEL


def mmproj_local_name(entry: dict) -> str:
    """Local filename for a vision projector. HF repos all name it mmproj-F16.gguf,
    which would collide across models in the shared models dir."""
    return f"mmproj-{entry['id']}.gguf"


def list_models() -> list[dict]:
    """Catalog entries with a `downloaded` flag + custom GGUFs found on disk."""
    catalog = load_catalog()
    known_files = set()
    for entry in catalog:
        path = LLM_MODELS_DIR / entry["hf_filename"]
        downloaded = path.exists()
        if entry.get("hf_mmproj_filename"):
            downloaded = downloaded and (LLM_MODELS_DIR / mmproj_local_name(entry)).exists()
            known_files.add(mmproj_local_name(entry))
            # Show the real download size (weights + vision projector)
            entry["size_bytes"] = (entry.get("size_bytes") or 0) + (entry.get("mmproj_size_bytes") or 0)
        entry["downloaded"] = downloaded
        entry["source"] = "catalog"
        known_files.add(entry["hf_filename"])

    custom = [
        {
            "id": f"custom:{f.name}",
            "name": f.stem,
            "description": "Custom model found in the models folder.",
            "hf_filename": f.name,
            "size_bytes": f.stat().st_size,
            "downloaded": True,
            "source": "custom",
            "ctx": DEFAULT_CTX,
            "ngl_suggestion": DEFAULT_NGL,
            "tags": ["custom"],
        }
        for f in sorted(LLM_MODELS_DIR.glob("*.gguf"))
        if f.name not in known_files and not f.name.lower().startswith("mmproj")
    ]
    return catalog + custom


def estimate_vram_mb(entry: dict) -> int:
    """How much VRAM this model is expected to hold, in MiB.

    Catalog entries declare it. A user's own GGUF doesn't, so it is derived from
    the file: weights land in VRAM about 1:1, plus the KV cache and compute
    buffers for a 16k context. Measured against the catalog's own numbers, whose
    declared/file ratio runs 1.22–1.32, so 1.25 + 500 MiB sits in the middle."""
    declared = entry.get("vram_estimate_mb")
    if isinstance(declared, (int, float)) and declared > 0:
        return int(declared)
    size_mb = (entry.get("size_bytes") or 0) / (1024 * 1024)
    return int(size_mb * 1.25 + 500) if size_mb else 0


def vram_budget_mb() -> int:
    """VRAM the LLM pool may fill, in MiB — total minus what the desktop needs.
    0 when no NVIDIA GPU is detected, which disables budgeting entirely."""
    total = detect_vram_gb() * 1024
    if total <= 0:
        return 0
    reserve = _env_int("MODLY_LLM_VRAM_RESERVE_MB", 768)
    return max(0, int(total) - reserve)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        return default


def resolve_model(model_id: str) -> dict:
    """Return {gguf_path, mmproj_path, ngl, ctx, vision, vram_mb} for a catalog id
    or a custom:<file> id."""
    if model_id.startswith("custom:"):
        # The name is user/agent-supplied and this path is both loaded and
        # DELETEd (DELETE /llm/models/{model_id}). Confine it to the models dir:
        # on Windows a backslash is a separator too, so "custom:..\..\x.gguf"
        # would otherwise resolve — and unlink — outside it.
        name = model_id[len("custom:"):]
        path = (LLM_MODELS_DIR / name).resolve()
        root = LLM_MODELS_DIR.resolve()
        if path.parent != root or not path.exists() or path.suffix != ".gguf":
            raise KeyError(f"Custom model not found: {model_id}")
        return {
            "gguf_path": path, "mmproj_path": None, "ngl": DEFAULT_NGL,
            "ctx": DEFAULT_CTX, "vision": False,
            "vram_mb": estimate_vram_mb({"size_bytes": path.stat().st_size}),
        }
    for entry in load_catalog():
        if entry["id"] == model_id:
            has_mmproj = bool(entry.get("hf_mmproj_filename"))
            return {
                "gguf_path": LLM_MODELS_DIR / entry["hf_filename"],
                "mmproj_path": LLM_MODELS_DIR / mmproj_local_name(entry) if has_mmproj else None,
                "ngl": entry.get("ngl_suggestion", DEFAULT_NGL),
                "ctx": entry.get("ctx", DEFAULT_CTX),
                "vision": "vision" in (entry.get("tags") or []),
                "vram_mb": estimate_vram_mb(entry),
            }
    raise KeyError(f"Unknown model id: {model_id}")


def binary_path() -> Path:
    return BIN_DIR / _BINARY_NAME


def binary_installed() -> bool:
    return binary_path().exists()


def has_nvidia_gpu() -> bool:
    return shutil.which("nvidia-smi") is not None


# ─── Binary bootstrap ─────────────────────────────────────────────────────────

def _fetch_release() -> dict:
    with urlopen(Request(_RELEASES_API, headers=_UA), timeout=30) as r:
        return _json.loads(r.read())


def _cuda_ver(name: str) -> tuple[int, int]:
    m = re.search(r"cuda-(?:cu)?(\d+)[._](\d+)", name.lower())
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def _driver_cuda_version() -> tuple[int, int]:
    """Highest CUDA version the installed NVIDIA driver supports (0,0 if unknown)."""
    try:
        out = subprocess.run(["nvidia-smi"], capture_output=True, text=True, timeout=10).stdout
        m = re.search(r"CUDA Version:\s*(\d+)\.(\d+)", out)
        return (int(m.group(1)), int(m.group(2))) if m else (0, 0)
    except Exception:
        return (0, 0)


def _pick_assets(assets: list[dict]) -> list[dict]:
    """Ordered list of assets to install for this machine.

    Windows + NVIDIA: the CUDA build (self-contained, includes CPU fallback)
    plus its matching `cudart-…` runtime package. Otherwise Vulkan, then CPU.
    macOS / Linux: the platform tarball (Vulkan variant preferred on Linux).
    """
    import platform as _platform

    def matching(ext: tuple[str, ...], *needles: str) -> list[dict]:
        return [
            a for a in assets
            if a["name"].endswith(ext) and all(n in a["name"].lower() for n in needles)
        ]

    if sys.platform == "win32":
        if has_nvidia_gpu():
            builds = matching((".zip",), "win", "x64", "cuda")
            builds = [b for b in builds if not b["name"].startswith("cudart")]
            if builds:
                driver = _driver_cuda_version()
                # Newest build the driver can run; if the driver version is
                # unknown, the oldest build has the widest compatibility.
                supported = [b for b in builds if _cuda_ver(b["name"]) <= driver]
                pool = supported or builds
                pick = max(pool, key=lambda b: _cuda_ver(b["name"])) if supported else \
                       min(pool, key=lambda b: _cuda_ver(b["name"]))
                ver = _cuda_ver(pick["name"])
                cudart = [
                    a for a in assets
                    if a["name"].startswith("cudart") and _cuda_ver(a["name"]) == ver
                ]
                return [pick, *cudart[:1]]
        return (matching((".zip",), "win", "x64", "vulkan")
                or matching((".zip",), "win", "x64", "cpu")
                or matching((".zip",), "win", "x64", "avx2"))[:1]

    if sys.platform == "darwin":
        arch = "arm64" if _platform.machine().lower() in ("arm64", "aarch64") else "x64"
        exts = (".zip", ".tar.gz")
        return (matching(exts, "macos", arch) or matching(exts, "macos"))[:1]

    exts = (".zip", ".tar.gz")
    return (matching(exts, "ubuntu", "vulkan", "x64")
            or matching(exts, "ubuntu", "x64")
            or matching(exts, "linux", "x64"))[:1]


def _download_asset(asset: dict, progress_cb: Callable[[dict], None], control_check: Callable[[], None], label: str) -> Path:
    suffix = ".tar.gz" if asset["name"].endswith(".tar.gz") else ".zip"
    fd, tmp_name = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    tmp = Path(tmp_name)
    with urlopen(Request(asset["browser_download_url"], headers=_UA), timeout=30) as resp:
        total = int(resp.headers.get("Content-Length", 0)) or asset.get("size", 0)
        done = 0
        last_emit = 0.0
        with open(tmp, "wb") as fh:
            while chunk := resp.read(1 << 20):
                control_check()
                fh.write(chunk)
                done += len(chunk)
                now = time.monotonic()
                if now - last_emit >= 0.5:
                    progress_cb({
                        "status": f"Downloading {label} ({asset['name']})",
                        "bytesDownloaded": done,
                        "totalBytes": total,
                        "percent": round(done / total * 100) if total else 0,
                    })
                    last_emit = now
    return tmp


_LIB_SUFFIXES = (".so", ".dylib", ".metal")


def _extract_archive(tmp: Path, asset_name: str) -> int:
    """Extract runtime files flat into BIN_DIR (exe/dll on Windows, bin/* + libs elsewhere)."""
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    count = 0

    def wanted(member_path: str, fname_low: str) -> bool:
        if sys.platform == "win32":
            return fname_low.endswith((".exe", ".dll"))
        return "/bin/" in member_path.replace("\\", "/") or fname_low.endswith(_LIB_SUFFIXES)

    if asset_name.endswith(".tar.gz"):
        import tarfile
        with tarfile.open(tmp, "r:gz") as tf:
            for m in tf.getmembers():
                if not m.isfile():
                    continue
                fname = Path(m.name).name
                if not fname or not wanted(m.name, fname.lower()):
                    continue
                src = tf.extractfile(m)
                if src is None:
                    continue
                dest = BIN_DIR / fname
                with open(dest, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                if not fname.lower().endswith(_LIB_SUFFIXES):
                    dest.chmod(0o755)
                count += 1
        return count

    with zipfile.ZipFile(tmp) as zf:
        for item in zf.infolist():
            if item.is_dir():
                continue
            fname = Path(item.filename).name
            if not fname or not wanted(item.filename, fname.lower()):
                continue
            dest = BIN_DIR / fname
            with zf.open(item) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst)
            if sys.platform != "win32" and not fname.lower().endswith(_LIB_SUFFIXES):
                dest.chmod(0o755)
            count += 1
    return count


def install_binary(progress_cb: Callable[[dict], None], control_check: Callable[[], None]) -> None:
    """Download and install the best llama-server build for this machine."""
    progress_cb({"status": "Fetching latest llama.cpp release…", "percent": 0})
    release = _fetch_release()
    progress_cb({"status": f"Release {release['tag_name']} — selecting build for this machine…", "percent": 1})

    assets = _pick_assets(release["assets"])
    if not assets:
        raise RuntimeError("No compatible llama.cpp build found for this platform.")

    for i, asset in enumerate(assets):
        label = "engine" if i == 0 else "CUDA runtime"
        tmp = _download_asset(asset, progress_cb, control_check, label)
        try:
            count = _extract_archive(tmp, asset["name"])
            progress_cb({"status": f"Extracted {count} files from {asset['name']}"})
        finally:
            tmp.unlink(missing_ok=True)

    if not binary_installed():
        raise RuntimeError("Install finished but llama-server binary is missing.")
    progress_cb({"status": "done", "percent": 100})


# ─── Orphan prevention ────────────────────────────────────────────────────────
# If Modly is force-killed, a plain child process would keep its model in
# memory forever. On Windows we put llama-server in a Job object with
# KILL_ON_JOB_CLOSE (the OS kills it when Modly dies); on Linux we ask the
# kernel to deliver SIGKILL on parent death.

_win_job_handle = None


def _windows_job() -> Optional[int]:
    global _win_job_handle
    if _win_job_handle is not None:
        return _win_job_handle
    try:
        import ctypes
        from ctypes import wintypes

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in (
                "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.windll.kernel32
        job = kernel32.CreateJobObjectW(None, None)
        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))  # JobObjectExtendedLimitInformation
        _win_job_handle = job
        return job
    except Exception:
        return None


def _tie_to_parent(process: subprocess.Popen) -> None:
    if sys.platform == "win32":
        job = _windows_job()
        if job is not None:
            try:
                import ctypes
                ctypes.windll.kernel32.AssignProcessToJobObject(job, int(process._handle))  # type: ignore[attr-defined]
            except Exception:
                pass


def _linux_preexec():
    try:
        import ctypes
        import signal as _signal
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        libc.prctl(1, _signal.SIGKILL)  # PR_SET_PDEATHSIG
    except Exception:
        pass


def _kill_stale_server(port: int = SERVER_PORT) -> None:
    """Kill a leftover llama-server holding `port` (e.g. after a force-kill of Modly)."""
    try:
        with urlopen(Request(f"http://127.0.0.1:{port}/health", headers=_UA), timeout=1) as r:
            if r.status != 200:
                return
    except Exception:
        return  # nothing listening — the normal case
    try:
        if sys.platform == "win32":
            out = subprocess.run(
                ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, timeout=10,
            ).stdout
            for line in out.splitlines():
                if f":{port}" in line and "LISTENING" in line.upper():
                    pid = line.split()[-1]
                    name = subprocess.run(
                        ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                        capture_output=True, text=True, timeout=10,
                    ).stdout.lower()
                    if "llama-server" in name:
                        subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True, timeout=10)
                    break
        else:
            out = subprocess.run(
                ["lsof", "-ti", f"tcp:{port}"], capture_output=True, text=True, timeout=10,
            ).stdout
            for pid in out.split():
                subprocess.run(["kill", "-9", pid], capture_output=True, timeout=10)
    except Exception:
        pass


# ─── Managed server ───────────────────────────────────────────────────────────

class LlamaServerManager:
    """One llama-server slot — a single loaded GGUF on a dedicated port.

    Slots are owned by LlamaPool, which decides how many run at once, evicts
    idle ones (IDLE_TTL_SECONDS), and unloads everything when the 3D pipeline
    needs the VRAM.
    """

    def __init__(self, port: int = SERVER_PORT) -> None:
        self.port = port
        self._lock = threading.Lock()
        self._process: Optional[subprocess.Popen] = None
        self._current_id: Optional[str] = None
        self._started_at: Optional[float] = None
        self._last_used: float = 0.0
        self._log_file = None
        # Requests currently being answered by this slot. Guarded by its own
        # lock: _lock is held for the whole of a cold start (up to 180 s), and a
        # request must never wait on that to declare itself in flight.
        self._inflight: int = 0
        self._inflight_lock = threading.Lock()
        # Expected VRAM of whatever this slot is serving, for the pool's budget.
        self.vram_mb: int = 0

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}/v1"

    def _alive(self) -> bool:
        return self._process is not None and self._process.poll() is None

    def ensure(self, model_id: str, spec: dict) -> None:
        """Blocking: make sure `model_id` is loaded, swapping the server if needed.
        `spec` comes from resolve_model()."""
        with self._lock:
            self._last_used = time.monotonic()
            if self._current_id == model_id and self._alive():
                return
            if not binary_installed():
                raise RuntimeError("llama-server is not installed. Install the engine in Settings → Agent.")
            if not spec["gguf_path"].exists():
                raise RuntimeError(f"Model file not found: {spec['gguf_path'].name}. Download it in Settings → Agent.")

            self._terminate_locked()
            _kill_stale_server(self.port)
            self._spawn(spec)
            self._current_id = model_id
            self._started_at = time.monotonic()
            self._last_used = time.monotonic()

    def touch(self) -> None:
        """Mark the server as recently used (postpones idle eviction)."""
        self._last_used = time.monotonic()

    @property
    def busy_count(self) -> int:
        with self._inflight_lock:
            return self._inflight

    def hold(self) -> None:
        """Claim the slot for a request that is about to start."""
        with self._inflight_lock:
            self._inflight += 1
            self._last_used = time.monotonic()

    def release(self) -> None:
        with self._inflight_lock:
            self._inflight -= 1
            self._last_used = time.monotonic()

    @contextlib.contextmanager
    def busy(self):
        """Hold the slot for the duration of one request.

        _last_used only moved when a completion *finished*, so a generation
        longer than IDLE_TTL_SECONDS — a Text-to-CAD node parked on /llm/chat,
        or an agent round on a 14B running on CPU — looked idle to the reaper,
        which terminated the server mid-answer: truncated stream, node failed
        with no message. Marking the request in flight covers the whole call,
        including the prompt-eval stall before the first token."""
        self.hold()
        try:
            yield self
        finally:
            self.release()

    def _spawn(self, spec: dict) -> None:
        n_threads = max(1, int((os.cpu_count() or 4) * 0.8))
        cmd = [
            str(binary_path()),
            "-m", str(spec["gguf_path"]),
            "--port", str(self.port),
            "--host", "127.0.0.1",
            "-c", str(spec["ctx"]),
            "-ngl", str(spec["ngl"]),
            "--jinja",
            "-np", "1",
            "--threads", str(n_threads),
            "--threads-batch", str(n_threads),
        ]
        if spec.get("mmproj_path"):
            cmd += ["--mmproj", str(spec["mmproj_path"])]
        if has_nvidia_gpu():
            # Halve KV-cache VRAM so the larger context still fits 12 GB cards.
            # V-cache quantization requires flash attention (fine on CUDA).
            cmd += ["-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0"]
        # llama-server resolves its plugin DLLs (ggml-cuda, ggml-cpu-*) relative
        # to cwd, not the exe path — running from bin/ is required.
        env = {**os.environ, "PATH": str(BIN_DIR) + os.pathsep + os.environ.get("PATH", "")}
        kwargs: dict = {}
        if sys.platform.startswith("linux"):
            kwargs["preexec_fn"] = _linux_preexec

        # Overwritten on every spawn (one log per slot/port) so a crash at
        # startup (OOM, corrupt GGUF) can be diagnosed instead of vanishing
        # into DEVNULL.
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        self._log_file = open(LOGS_DIR / f"slot-{self.port}.log", "w", encoding="utf-8")

        self._process = subprocess.Popen(
            cmd,
            stdout=self._log_file,
            stderr=subprocess.STDOUT,
            cwd=str(BIN_DIR),
            env=env,
            **kwargs,
        )
        _tie_to_parent(self._process)
        self._wait_for_health()

    def _wait_for_health(self, timeout: float = 180.0, interval: float = 1.0) -> None:
        url = f"http://127.0.0.1:{self.port}/health"
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not self._alive():
                raise RuntimeError("llama-server exited during startup (bad model file or out of memory?).")
            try:
                with urlopen(Request(url, headers=_UA), timeout=2) as r:
                    if r.status == 200:
                        return
            except Exception:
                pass
            time.sleep(interval)
        self._terminate_locked()
        raise TimeoutError(f"llama-server did not become ready within {timeout:.0f}s")

    def unload(self) -> None:
        with self._lock:
            self._terminate_locked()

    def _terminate_locked(self) -> None:
        if self._process is None:
            return
        try:
            self._process.terminate()
            try:
                self._process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self._process.kill()
        except Exception:
            pass
        finally:
            self._process = None
            self._current_id = None
            self._started_at = None
            if self._log_file is not None:
                self._log_file.close()
                self._log_file = None

    def snapshot(self) -> dict:
        alive = self._alive()
        return {
            "alive": alive,
            "model_id": self._current_id if alive else None,
            "port": self.port,
            "uptime_seconds": round(time.monotonic() - self._started_at, 1) if alive and self._started_at else None,
            "vram_mb": self.vram_mb if alive else None,
        }


class LlamaPool:
    """Pool of llama-server slots — one process per loaded model, each on its
    own port, capped by BOTH resolve_max_models() and vram_budget_mb()
    (LRU eviction).

    The idle reaper and unload_all() keep the old guarantees: models are
    evicted after IDLE_TTL_SECONDS unused, and the 3D pipeline can reclaim all
    VRAM at once.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._slots: dict[str, LlamaServerManager] = {}
        # Ports held by a load in flight. A reserved slot has no process yet, so
        # _alive() cannot tell it apart from a dead one; tracking the port rather
        # than the model_id keeps the reservation valid even if unload() drops
        # the slot from _slots while it is still starting.
        self._loading_ports: set[int] = set()
        # Signalled whenever a load lands, so callers held back by a concurrent
        # cold start can re-run the limit check instead of loading on top of it.
        self._cond = threading.Condition(self._lock)
        self._reaper_started = False

    def ensure(self, model_id: str, spec: dict, hold: bool = False) -> LlamaServerManager:
        """Blocking: return a ready slot serving `model_id`, starting it (and
        evicting the least-recently-used slots) if needed.

        With `hold`, the slot is returned already claimed for one request and the
        caller MUST call slot.release() when done (see busy()). Without it there
        is a window between "loaded" and "in flight" in which a competing load
        can evict the slot, and the caller then posts to a dead server: with
        max_models = 1, two nodes asking for different models had one of them
        answer 500 Internal Server Error.

        The slot is reserved under the pool lock but LOADED outside it. A cold
        start blocks in _wait_for_health for up to 180 s, and holding the pool
        lock that long froze every other caller: /llm/status, polled by an open
        Settings → Agent page, hung for the whole load, and switch_model's
        unload_all() — which exists to reclaim VRAM before a 3D model — queued
        behind the very LLM competing for it.

        Loading outside the lock means two callers can be starting different
        models at the same time (an agent turn plus a workflow LLM node). A slot
        being started holds no process, so it cannot be evicted to make room:
        when only such loads keep the pool over its limit, this waits for one to
        land — it then becomes an ordinary eviction candidate — instead of
        putting a second model on a card sized for one.
        """
        incoming_mb = spec.get("vram_mb") or 0
        # A last resort, not a policy: past this the thing we are waiting for is
        # stuck, and blocking forever would be worse than loading on top of it.
        deadline = time.monotonic() + 300.0
        with self._lock:
            while True:
                slot = self._slots.get(model_id)
                if slot is not None and slot._alive():
                    break
                # Also for a dead slot respawned in place, so reviving one
                # cannot push the pool past the limit. Only alive slots that are
                # not answering a request are eviction candidates, so this never
                # evicts our own — nor anyone's live stream.
                self._enforce_limit_locked(reserve=1, incoming_mb=incoming_mb)
                remaining = deadline - time.monotonic()
                if (not self._over_capacity_locked(incoming_mb)
                        or not self._transient_blockers_locked()
                        or remaining <= 0):
                    break
                # Re-checked about once a second: capacity also frees up when a
                # request finishes, which is not a load event and so notifies
                # nothing.
                self._cond.wait(min(1.0, remaining))
            if slot is None:
                used_ports = {s.port for s in self._slots.values() if s._alive()} | self._loading_ports
                port = next(
                    (SERVER_PORT + i for i in range(MAX_SLOT_PORTS)
                     if SERVER_PORT + i not in used_ports),
                    None,
                )
                if port is None:
                    # A bare next() raised StopIteration here, which surfaced to
                    # the caller as "Could not start the local LLM: " — an empty
                    # message. Say what actually happened.
                    raise RuntimeError(
                        f"All {MAX_SLOT_PORTS} local-LLM slots are in use or starting up. "
                        "Wait for a run to finish, or lower the model limit in Settings → Agent."
                    )
                slot = LlamaServerManager(port)
                self._slots[model_id] = slot
            slot.vram_mb = incoming_mb
            self._loading_ports.add(slot.port)
            if hold:
                # Claimed BEFORE the load, not after: a caller woken by this load
                # landing would otherwise find the slot idle and evict it, and
                # two racing callers spent their time killing each other's
                # freshly loaded model until one gave up.
                slot.hold()
            self._start_reaper()

        # Outside the pool lock. LlamaServerManager holds its own, so concurrent
        # callers for the same model serialise here and the later ones no-op.
        try:
            slot.ensure(model_id, spec)
        except Exception:
            if hold:
                slot.release()  # nothing to answer with — do not pin the slot
            with self._lock:
                if self._slots.get(model_id) is slot and not slot._alive():
                    self._slots.pop(model_id, None)
            raise
        finally:
            with self._lock:
                self._loading_ports.discard(slot.port)
                self._cond.notify_all()  # waiters can re-run the limit check
        return slot

    def _evictable_locked(self, slot: LlamaServerManager) -> bool:
        """May this slot be unloaded to make room? Shared by the limit check and
        the idle reaper, which both unload while holding the pool lock — a rule
        applied to only one of them is a rule that does not hold.

        A slot answering a request is spared because terminating it truncates
        the caller's stream mid-generation. A slot another thread is loading is
        spared for a harder reason: from the moment Popen returns it is _alive()
        (the long wait is _wait_for_health, up to 180 s) while its own lock is
        held by the loader, so unload() would block on that lock and freeze the
        whole pool with it — /llm/status, every ensure(), and the unload_all()
        the 3D pipeline needs to reclaim VRAM. Its cost is still counted, it
        just cannot be the victim."""
        return slot.busy_count == 0 and slot.port not in self._loading_ports

    def _enforce_limit_locked(self, reserve: int = 0, incoming_mb: int = 0) -> None:
        """Evict LRU slots until the pool fits BOTH limits: the configured model
        count, and the VRAM budget.

        The count alone was not enough. `max_models: 2` let any two models in,
        so a 9 GB custom model plus a vision model on a 12 GB card oversubscribed
        the card; Windows spills to shared memory instead of failing, so nothing
        errored — a cold start just went from 5 s to 24 s with no explanation.
        Budgeting on declared estimates keeps the pairs that actually fit (a 4B
        and a 7B come to 10.4 of 11.5 GiB) and refuses the ones that never did.

        The incoming model is never rejected: if it does not fit even alone,
        everything else is evicted and it loads by itself."""
        alive = [(mid, s) for mid, s in self._slots.items() if s._alive()]
        alive.sort(key=lambda kv: kv[1]._last_used)  # oldest first
        # Slots reserved by a concurrent ensure() hold no process yet, so
        # _alive() cannot see them. Counting only live slots let two concurrent
        # ensure() calls — an agent turn plus a workflow LLM node — each
        # conclude the pool was empty and both load, which on an 8 GB card
        # (max_models = 1) is exactly the oversubscription this rule prevents.
        loading = [s for s in self._slots.values()
                   if s.port in self._loading_ports and not s._alive()]
        candidates = [kv for kv in alive if self._evictable_locked(kv[1])]

        def _evict_oldest() -> None:
            mid, slot = candidates.pop(0)
            alive.remove((mid, slot))
            slot.unload()
            self._slots.pop(mid, None)

        max_n = resolve_max_models()
        while len(alive) + len(loading) + reserve > max_n and candidates:
            _evict_oldest()

        budget = vram_budget_mb()
        if not budget or not incoming_mb:
            return  # no GPU detected, or an unknown estimate — count rule only

        def _committed_mb() -> int:
            return sum(s.vram_mb for _mid, s in alive) + sum(s.vram_mb for s in loading)

        while candidates and _committed_mb() + incoming_mb > budget:
            _evict_oldest()

    def _transient_blockers_locked(self) -> bool:
        """Is the pool full only of things that end on their own — a load in
        flight, or a slot answering a request? Those are worth waiting for; a
        merely idle slot is not (it gets evicted instead)."""
        return bool(self._loading_ports) or any(
            s.busy_count for s in self._slots.values() if s._alive()
        )

    def _over_capacity_locked(self, incoming_mb: int) -> bool:
        """Would loading one more model break either limit, counting the slots
        another thread is starting right now?"""
        alive   = [s for s in self._slots.values() if s._alive()]
        loading = [s for s in self._slots.values()
                   if s.port in self._loading_ports and not s._alive()]
        if len(alive) + len(loading) + 1 > resolve_max_models():
            return True
        budget = vram_budget_mb()
        if not budget or not incoming_mb:
            return False  # no GPU detected, or an unknown estimate
        committed = sum(s.vram_mb for s in alive) + sum(s.vram_mb for s in loading)
        return committed + incoming_mb > budget

    def enforce_limit(self) -> None:
        """Apply the configured limit right away (used when the user lowers it)."""
        with self._lock:
            self._enforce_limit_locked()

    def is_loaded(self, model_id: str) -> bool:
        with self._lock:
            slot = self._slots.get(model_id)
            return slot is not None and slot._alive()

    def touch(self, model_id: str) -> None:
        with self._lock:
            slot = self._slots.get(model_id)
            if slot is not None:
                slot.touch()

    def unload(self, model_id: str) -> None:
        with self._lock:
            slot = self._slots.pop(model_id, None)
        if slot is not None:
            slot.unload()

    def unload_all(self) -> None:
        with self._lock:
            slots = list(self._slots.values())
            self._slots.clear()
        for slot in slots:
            slot.unload()

    def _start_reaper(self) -> None:
        if self._reaper_started or IDLE_TTL_SECONDS <= 0:
            return
        self._reaper_started = True
        threading.Thread(target=self._reap_idle, daemon=True, name="llm-idle-reaper").start()

    def _reap_idle(self) -> None:
        while True:
            time.sleep(15)
            self._reap_once()

    def _reap_once(self, now: Optional[float] = None) -> None:
        now = time.monotonic() if now is None else now
        with self._lock:
            for mid, slot in list(self._slots.items()):
                if not self._evictable_locked(slot):
                    continue  # answering right now, or being loaded — never idle
                if slot._alive() and now - slot._last_used > IDLE_TTL_SECONDS:
                    slot.unload()
                    self._slots.pop(mid, None)

    def snapshot(self) -> dict:
        with self._lock:
            slots = list(self._slots.values())
        servers = [s.snapshot() for s in slots if s._alive()]
        first = servers[0] if servers else {"alive": False, "model_id": None, "port": SERVER_PORT, "uptime_seconds": None}
        return {
            **first,  # legacy single-server shape
            "servers": servers,
            "max_models": resolve_max_models(),
            "vram_gb": detect_vram_gb() or None,
            "vram_budget_mb": vram_budget_mb() or None,
            "vram_used_mb": sum(s.get("vram_mb") or 0 for s in servers) or None,
        }


llama_pool = LlamaPool()
