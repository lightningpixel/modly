"""
SF3DGenerator — adapter for StableFast3D (stabilityai/stable-fast-3d).
Target: low-end PCs, ~4 GB VRAM.
"""
import io
import sys
import time
import threading
import uuid
import zipfile
from pathlib import Path
from typing import Callable, List, Optional, Union

from PIL import Image

from .base import BaseGenerator, smooth_progress

_GITHUB_ZIP = "https://github.com/Stability-AI/stable-fast-3d/archive/refs/heads/main.zip"


class SF3DGenerator(BaseGenerator):
    MODEL_ID     = "sf3d"
    DISPLAY_NAME = "StableFast3D"
    VRAM_GB      = 4

    # ------------------------------------------------------------------ #

    def is_downloaded(self) -> bool:
        return self.model_dir.exists() and any(self.model_dir.iterdir())

    def load(self) -> None:
        if self._model is not None:
            return
        if not self.is_downloaded():
            raise RuntimeError(
                f"SF3D not found in {self.model_dir}. "
                "Please download it from the app first."
            )

        self._ensure_sf3d_source()

        weight_candidates = list(self.model_dir.glob("*.safetensors"))
        if not weight_candidates:
            raise RuntimeError(f"No .safetensors file found in {self.model_dir}")

        config_path = self.model_dir / "config.yaml"
        if not config_path.exists():
            raise RuntimeError(f"config.yaml not found in {self.model_dir}")

        import torch
        from sf3d.system import SF3D

        print(f"[SF3DGenerator] Loading from {self.model_dir}…")
        model = SF3D.from_pretrained(
            str(self.model_dir),
            config_name="config.yaml",
            weight_name=weight_candidates[0].name,
        )
        model.eval()

        # Fix 2: move to the correct device once at load time
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model.to(device)

        self._model = model
        print(f"[SF3DGenerator] Loaded on {device}.")

    # ------------------------------------------------------------------ #

    def generate(
        self,
        image_bytes: Union[bytes, List[bytes]],
        params: dict,
        progress_cb: Optional[Callable[[int, str], None]] = None,
    ) -> Path:
        import torch

        # SF3D only supports single-image input; use first image if list provided
        if isinstance(image_bytes, list):
            image_bytes = image_bytes[0]

        vertex_count = int(params.get("vertex_count", 10000))
        remesh       = str(params.get("remesh", "quad"))

        try:
            from uv_unwrapper import Unwrapper  # noqa: F401
            texturing_available = True
        except ImportError:
            texturing_available = False

        enable_texture     = str(params.get("enable_texture", "true")).lower() == "true"
        texture_resolution = max(64, min(2048, int(params.get("texture_resolution", 512))))
        bake_res = texture_resolution if (texturing_available and enable_texture) else 0

        # Step 1: background removal
        self._report(progress_cb, 5, "Removing background…")
        image = self._preprocess(image_bytes)

        # Step 2: neural inference (long operation, no internal callback)
        # A thread is started to smoothly increment the progress bar in the meantime.
        self._report(progress_cb, 10, "Running neural inference…")
        stop_event = threading.Event()

        if progress_cb:
            smooth_thread = threading.Thread(
                target=smooth_progress,
                args=(progress_cb, 10, 70, "Running neural inference…", stop_event),
                daemon=True,
            )
            smooth_thread.start()

        try:
            with torch.no_grad():
                mesh, _ = self._model.run_image(
                    image,
                    bake_resolution=bake_res,
                    remesh=remesh,
                    vertex_count=vertex_count,
                )
        finally:
            stop_event.set()

        # Step 3: remesh + export
        self._report(progress_cb, 75, "Remeshing geometry…")
        self._report(progress_cb, 90, "Exporting GLB…")

        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        output_name = f"{int(time.time())}_{uuid.uuid4().hex[:8]}.glb"
        output_path = self.outputs_dir / output_name
        mesh.export(str(output_path))

        self._report(progress_cb, 100, "Done")
        return output_path

    # ------------------------------------------------------------------ #

    @classmethod
    def params_schema(cls) -> list:
        return [
            {
                "id":      "vertex_count",
                "label":   "Mesh Quality",
                "type":    "select",
                "default": 10000,
                "options": [
                    {"value": 5000,  "label": "Low (5k)"},
                    {"value": 10000, "label": "Medium (10k)"},
                    {"value": 20000, "label": "High (20k)"},
                ],
            },
            {
                "id":      "remesh",
                "label":   "Remesh",
                "type":    "select",
                "default": "quad",
                "options": [
                    {"value": "quad",     "label": "Quad"},
                    {"value": "triangle", "label": "Triangle"},
                    {"value": "none",     "label": "None"},
                ],
            },
        ]

    # ------------------------------------------------------------------ #

    def _ensure_sf3d_source(self) -> None:
        try:
            from sf3d.system import SF3D  # noqa: F401
            return
        except ImportError:
            pass

        src_dir = self.model_dir / "_sf3d_source"
        if not (src_dir / "sf3d").exists():
            self._download_sf3d_source(src_dir)

        if str(src_dir) not in sys.path:
            sys.path.insert(0, str(src_dir))

        try:
            from sf3d.system import SF3D  # noqa: F401
        except ImportError as exc:
            raise RuntimeError(
                f"sf3d still not importable after extraction to {src_dir}.\n{exc}"
            ) from exc

    def _download_sf3d_source(self, dest: Path) -> None:
        import urllib.request

        dest.mkdir(parents=True, exist_ok=True)
        print("[SF3DGenerator] Downloading sf3d source from GitHub…")
        with urllib.request.urlopen(_GITHUB_ZIP, timeout=180) as resp:
            data = resp.read()
        print("[SF3DGenerator] Extracting sf3d source…")

        prefix = "stable-fast-3d-main/sf3d/"
        strip  = "stable-fast-3d-main/"

        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for member in zf.namelist():
                if not member.startswith(prefix):
                    continue
                rel    = member[len(strip):]
                target = dest / rel
                if member.endswith("/"):
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(zf.read(member))

        print(f"[SF3DGenerator] sf3d source extracted to {dest}.")

    def _preprocess(self, image_bytes: bytes) -> Image.Image:
        import rembg
        image = Image.open(io.BytesIO(image_bytes))
        return rembg.remove(image).convert("RGBA")
