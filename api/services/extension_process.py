"""
ExtensionProcess — manages a generator running in an isolated subprocess.

Each extension runs in its own venv via runner.py.
Communication is done via newline-delimited JSON on stdin/stdout.

Interface is intentionally compatible with direct BaseGenerator usage
so GeneratorRegistry can treat both transparently.
"""
import base64
import json
import os
import platform
import queue
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from typing import Callable, Optional

_RUNNER_PATH = Path(__file__).parent.parent / "runner.py"


def _venv_python(ext_dir: Path) -> Path:
    """Returns the path to the venv's Python executable."""
    if platform.system() == "Windows":
        return ext_dir / "venv" / "Scripts" / "python.exe"
    return ext_dir / "venv" / "bin" / "python"


class ExtensionProcess:
    """
    Wraps an extension subprocess. Presents the same interface as a
    direct generator (load / unload / generate / is_loaded / params_schema).
    """

    def __init__(self, ext_dir: Path, manifest: dict) -> None:
        self.ext_dir       = ext_dir
        self.manifest      = manifest
        self.model_dir     = None   # set by registry after init
        self.outputs_dir   = None   # set by registry after init

        self._proc:   Optional[subprocess.Popen] = None
        self._queue:  queue.Queue                = queue.Queue()
        self._lock:   threading.Lock             = threading.Lock()
        self._loaded: bool                       = False

        # Mirrors BaseGenerator attributes used by the registry
        self.hf_repo          = manifest.get("hf_repo", "")
        self.hf_skip_prefixes = manifest.get("hf_skip_prefixes", [])
        self.download_check   = manifest.get("download_check", "")
        self._params_schema   = manifest.get("params_schema", [])

        # Public metadata
        self.MODEL_ID     = manifest.get("id", "")
        self.DISPLAY_NAME = manifest.get("name", "")
        self.VRAM_GB      = manifest.get("vram_gb", 0)

    # ------------------------------------------------------------------ #
    # Subprocess lifecycle
    # ------------------------------------------------------------------ #

    def _build_env(self) -> dict:
        from services.generator_registry import MODELS_DIR, WORKSPACE_DIR
        env = os.environ.copy()
        env["EXTENSION_DIR"] = str(self.ext_dir)
        env["MODELS_DIR"]    = str(MODELS_DIR)
        env["WORKSPACE_DIR"] = str(WORKSPACE_DIR)
        env["MODLY_API_DIR"] = str(Path(__file__).parent.parent)
        # Pass the exact model_dir so runner.py doesn't have to re-derive it
        # from manifest["id"] (which is the ext_id, not the composite node id).
        # runner.py extracts the node id from MODEL_DIR's trailing path component.
        if self.model_dir is not None:
            env["MODEL_DIR"] = str(self.model_dir)
        return env

    def _start(self) -> None:
        """Launch the subprocess and wait for the 'ready' signal."""
        python = _venv_python(self.ext_dir)
        if not python.exists():
            raise RuntimeError(
                f"[{self.MODEL_ID}] venv not found at {python}. "
                "Run the extension's setup.py first."
            )

        # Use a fresh queue per subprocess lifetime so late messages from an
        # older reader thread cannot poison startup for the new process.
        run_queue: queue.Queue = queue.Queue()
        self._queue = run_queue

        self._proc = subprocess.Popen(
            [str(python), str(_RUNNER_PATH)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=self._build_env(),
        )

        # Background thread: read stdout → queue
        reader = threading.Thread(target=self._read_loop, args=(self._proc, run_queue), daemon=True)
        reader.start()

        # Background thread: forward stderr to our stderr
        stderr_fwd = threading.Thread(target=self._stderr_loop, args=(self._proc,), daemon=True)
        stderr_fwd.start()

        # Wait for ready — runner sends params_schema in this message
        msg = self._recv(timeout=None)
        if msg.get("type") != "ready":
            self._proc.kill()
            raise RuntimeError(f"[{self.MODEL_ID}] Expected 'ready', got: {msg}")

        # Override params_schema with what the generator class actually declares
        if msg.get("params_schema"):
            self._params_schema = msg["params_schema"]

        print(f"[ExtensionProcess] {self.MODEL_ID} subprocess started (pid {self._proc.pid})")

    def _read_loop(self, proc: subprocess.Popen, msg_queue: queue.Queue) -> None:
        """Continuously reads stdout and pushes parsed JSON to the queue."""
        try:
            for line in proc.stdout:
                line = line.strip()
                if line:
                    try:
                        msg_queue.put(json.loads(line))
                    except json.JSONDecodeError:
                        print(f"[{self.MODEL_ID}] bad JSON: {line}", file=sys.stderr)
        finally:
            msg_queue.put(None)  # sentinel: process is done

    def _stderr_loop(self, proc: subprocess.Popen) -> None:
        """Forward subprocess stderr to the main process stderr, emitting
        one line every time we see EITHER '\\n' or '\\r'. tqdm writes live
        progress updates with '\\r' only, so a newline-only iterator would
        buffer every tick until the loop exits with '\\n' — which is why
        the HUD's log pane went dark during multi-minute volume decode.

        No per-line extension-id prefix: the HUD log pane is a single
        truncated line, and eating 20 characters with "[modly-hy3d2-mac] "
        hides the tail of the tqdm bar the user actually wants to read.
        """
        stream = proc.stderr
        if stream is None:
            return
        buf = []
        while True:
            ch = stream.read(1)
            if not ch:
                if buf:
                    print(''.join(buf), file=sys.stderr, flush=True)
                return
            if ch in ("\r", "\n"):
                if buf:
                    print(''.join(buf), file=sys.stderr, flush=True)
                    buf = []
            else:
                buf.append(ch)

    def _send(self, msg: dict) -> None:
        with self._lock:
            self._proc.stdin.write(json.dumps(msg) + "\n")
            self._proc.stdin.flush()

    def _recv(self, timeout: float | None = 120.0) -> dict:
        try:
            msg = self._queue.get(timeout=timeout)
        except queue.Empty:
            raise TimeoutError(f"[{self.MODEL_ID}] No response from subprocess after {timeout}s")
        if msg is None:
            raise RuntimeError(f"[{self.MODEL_ID}] Subprocess died unexpectedly")
        return msg

    def _ensure_started(self) -> None:
        if self._proc is None or self._proc.poll() is not None:
            self._start()

    # ------------------------------------------------------------------ #
    # BaseGenerator-compatible interface
    # ------------------------------------------------------------------ #

    def is_downloaded(self) -> bool:
        if self.download_check:
            return (self.model_dir / self.download_check).exists()
        return self.model_dir.exists() and any(self.model_dir.iterdir())

    def is_loaded(self) -> bool:
        return self._loaded and self._proc is not None and self._proc.poll() is None

    def load(self) -> None:
        self._ensure_started()
        self._send({"action": "load"})

        msg = self._recv(timeout=None)  # model load can be arbitrarily slow
        if msg.get("type") == "loaded":
            self._loaded = True
        elif msg.get("type") == "error":
            raise RuntimeError(msg.get("traceback") or msg.get("message"))
        else:
            raise RuntimeError(f"[{self.MODEL_ID}] Unexpected response to load: {msg}")

    def unload(self) -> None:
        if self._proc and self._proc.poll() is None:
            try:
                self._send({"action": "unload"})
                self._recv(timeout=30.0)
            except Exception:
                pass
        self._loaded = False

    def generate(
        self,
        image_bytes: bytes,
        params: dict,
        progress_cb: Optional[Callable[[int, str], None]] = None,
        cancel_event: Optional[threading.Event] = None,
    ) -> Path:
        from services.generators.base import GenerationCancelled

        req_id = str(uuid.uuid4())
        self._send({
            "action":      "generate",
            "id":          req_id,
            "image_b64":   base64.b64encode(image_bytes).decode(),
            "params":      params,
            "outputs_dir": str(self.outputs_dir) if self.outputs_dir else None,
        })

        # Grace period after sending a cooperative cancel before hard-killing
        # the subprocess. Long enough to let generators that check cancel_event
        # between steps shut down cleanly, short enough that the user isn't
        # left staring at a stuck UI when the subprocess is blocked inside a
        # native call (octree decode, marching cubes, etc.) that ignores stdin.
        CANCEL_GRACE_SECONDS = 3.0

        cancel_sent_at: Optional[float] = None
        while True:
            # Check for cancellation
            if cancel_event and cancel_event.is_set():
                if cancel_sent_at is None:
                    # First observation of the cancel — ask the subprocess to stop.
                    try:
                        self._send({"action": "cancel", "id": req_id})
                    except Exception:
                        pass
                    import time
                    cancel_sent_at = time.monotonic()
                else:
                    import time
                    if time.monotonic() - cancel_sent_at >= CANCEL_GRACE_SECONDS:
                        # Grace period expired — the subprocess is not
                        # responding (almost certainly stuck in native code).
                        # Hard-kill it and drop our state so the next
                        # generation forces a fresh load.
                        try:
                            if self._proc and self._proc.poll() is None:
                                self._proc.kill()
                                self._proc.wait(timeout=5.0)
                        except Exception:
                            pass
                        self._loaded = False
                        self._proc   = None
                        print(
                            f"[ExtensionProcess] {self.MODEL_ID} subprocess killed "
                            f"after {CANCEL_GRACE_SECONDS}s grace; model will reload on next run",
                            file=sys.stderr,
                        )
                        raise GenerationCancelled()

            # Poll queue with short timeout so we can re-check cancel_event
            try:
                msg = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue

            if msg is None:
                raise RuntimeError(f"[{self.MODEL_ID}] Subprocess died during generation")

            t = msg.get("type")

            if t == "progress":
                if progress_cb:
                    progress_cb(msg.get("pct", 0), msg.get("step", ""))

            elif t == "done":
                return Path(msg["output_path"])

            elif t == "error":
                raise RuntimeError(msg.get("traceback") or msg.get("message", "Unknown error"))

            elif t == "cancelled":
                raise GenerationCancelled()

            elif t == "log":
                print(f"[{self.MODEL_ID}] {msg.get('message', '')}", file=sys.stderr)

    def params_schema(self) -> list:
        return self._params_schema

    def stop(self) -> None:
        """Hard-stop the subprocess.

        Used by Free Memory / unload_all. Cooperative shutdown was the wrong
        semantics here: torch.mps.empty_cache() does not reliably release
        wired Metal pages, so only process exit actually returns the memory
        to the OS. We SIGKILL, reap the zombie, and drop our refs so the
        next load() starts a fresh subprocess.
        """
        proc = self._proc
        self._proc   = None
        self._loaded = False
        if proc and proc.poll() is None:
            try:
                proc.kill()
                proc.wait(timeout=5)
            except Exception:
                pass
        self._drain_queue()

    def _drain_queue(self) -> None:
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
