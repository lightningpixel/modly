"""
Hunyuan3DGenerator — adapter for Hunyuan3D-2.1 (tencent/Hunyuan3D-2.1).

Target     : high-end PCs, ≥10 GB VRAM (shape-only; PBR texture requires ≥21 GB).
Pipeline   : image → rembg → DiT flow-matching → octree VAE decode → GLB
Reference  : https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1

GitHub repo structure:
    Hunyuan3D-2.1-main/
    └── hy3dshape/              ← external folder (added to sys.path)
        └── hy3dshape/          ← importable Python package
            ├── __init__.py
            └── pipelines.py   ← Hunyuan3DDiTFlowMatchingPipeline
"""
import io
import sys
import time
import threading
import uuid
import zipfile
from pathlib import Path
from typing import Callable, Optional

from PIL import Image

from .base import BaseGenerator, smooth_progress

_HF_REPO_ID  = "tencent/Hunyuan3D-2.1"
_GITHUB_ZIP  = "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1/archive/refs/heads/main.zip"


class Hunyuan3DGenerator(BaseGenerator):
    MODEL_ID     = "hunyuan3d"
    DISPLAY_NAME = "Hunyuan3D 2.1"
    VRAM_GB      = 10  # shape-only pipeline

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #

    def is_downloaded(self) -> bool:
        """Shape weights are present if the DIT folder exists."""
        return (self.model_dir / "hunyuan3d-dit-v2-1").exists()

    def load(self) -> None:
        if self._model is not None:
            return

        # Fallback download if weights are missing
        # (the primary path goes through the SSE endpoint /model/hf-download)
        if not self.is_downloaded():
            self._download_weights()

        # Ensure the hy3dshape package is importable
        self._ensure_hy3dshape()

        import torch
        from hy3dshape.pipelines import Hunyuan3DDiTFlowMatchingPipeline

        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype  = torch.float16 if device == "cuda" else torch.float32

        print(f"[Hunyuan3DGenerator] Loading pipeline from {self.model_dir}…")
        pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
            str(self.model_dir),
            torch_dtype=dtype,
        )
        pipeline.to(device)   # modifies in place, does not return self
        self._model = pipeline
        print(f"[Hunyuan3DGenerator] Loaded on {device}.")

    # ------------------------------------------------------------------ #
    # Inference
    # ------------------------------------------------------------------ #

    def generate(
        self,
        image_bytes: bytes,
        params: dict,
        progress_cb: Optional[Callable[[int, str], None]] = None,
    ) -> Path:
        import torch

        num_steps  = int(params.get("num_inference_steps", 50))
        vert_count = int(params.get("vertex_count", 0))

        # Step 1 — background removal
        self._report(progress_cb, 5, "Removing background…")
        image = self._preprocess(image_bytes)

        # Step 2 — shape generation (long, no internal callbacks)
        self._report(progress_cb, 12, "Generating 3D shape…")
        stop_evt = threading.Event()
        if progress_cb:
            t = threading.Thread(
                target=smooth_progress,
                args=(progress_cb, 12, 82, "Generating 3D shape…", stop_evt),
                daemon=True,
            )
            t.start()

        try:
            with torch.no_grad():
                outputs = self._model(
                    image=image,
                    num_inference_steps=num_steps,
                )
            mesh = outputs[0]  # trimesh.Trimesh
        finally:
            stop_evt.set()

        # Step 3 — optional decimation to the target vertex count
        if vert_count > 0 and hasattr(mesh, "vertices") and len(mesh.vertices) > vert_count:
            self._report(progress_cb, 85, "Optimizing mesh…")
            mesh = self._decimate(mesh, vert_count)

        # Step 4 — GLB export
        self._report(progress_cb, 93, "Exporting GLB…")
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        name = f"{int(time.time())}_{uuid.uuid4().hex[:8]}.glb"
        path = self.outputs_dir / name
        mesh.export(str(path))

        self._report(progress_cb, 100, "Done")
        return path

    # ------------------------------------------------------------------ #
    # Internal helpers
    # ------------------------------------------------------------------ #

    def _preprocess(self, image_bytes: bytes) -> Image.Image:
        import rembg
        return rembg.remove(Image.open(io.BytesIO(image_bytes))).convert("RGBA")

    def _decimate(self, mesh, target_vertices: int):
        """Simplifies the mesh to target_vertices (approximation via face count)."""
        target_faces = max(4, target_vertices * 2)
        try:
            return mesh.simplify_quadric_decimation(target_faces)
        except Exception as exc:
            print(f"[Hunyuan3DGenerator] Decimation skipped: {exc}")
            return mesh

    def _download_weights(self) -> None:
        """Downloads shape weights from HuggingFace Hub (without the PBR texture model)."""
        from huggingface_hub import snapshot_download
        print(f"[Hunyuan3DGenerator] Downloading {_HF_REPO_ID} (shape weights)…")
        snapshot_download(
            repo_id=_HF_REPO_ID,
            local_dir=str(self.model_dir),
            ignore_patterns=[
                "hunyuan3d-paintpbr-v2-1/**",  # texture model (21 GB VRAM, not required)
                "*.md", "LICENSE", "Notice.txt", ".gitattributes",
            ],
        )
        print("[Hunyuan3DGenerator] Download complete.")

    def _ensure_hy3dshape(self) -> None:
        """
        Makes hy3dshape importable.

        The package is in the GitHub repo (not on HuggingFace or PyPI).
        Structure after archive extraction:
            model_dir/_hy3dshape/
            └── hy3dshape/          ← added to sys.path
                └── hy3dshape/      ← importable package
                    ├── __init__.py
                    └── pipelines.py
        """
        try:
            import hy3dshape  # noqa: F401
            return  # already importable
        except ImportError:
            pass

        outer = self.model_dir / "_hy3dshape" / "hy3dshape"
        if not outer.exists():
            self._download_hy3dshape()

        if str(outer) not in sys.path:
            sys.path.insert(0, str(outer))

        try:
            import hy3dshape  # noqa: F401
        except ImportError as exc:
            raise RuntimeError(
                f"hy3dshape still not importable after extraction to {outer}.\n"
                f"Check the folder contents.\n{exc}"
            ) from exc

    def _download_hy3dshape(self) -> None:
        """
        Extracts the hy3dshape/ folder from the GitHub repo ZIP archive.

        The GitHub repo has the following structure:
            Hunyuan3D-2.1-main/
            └── hy3dshape/          ← this is extracted
                └── hy3dshape/      ← Python package
                    ├── __init__.py
                    └── pipelines.py

        After extraction:
            model_dir/_hy3dshape/hy3dshape/hy3dshape/__init__.py
        """
        import urllib.request

        dest = self.model_dir / "_hy3dshape"
        dest.mkdir(parents=True, exist_ok=True)

        print(f"[Hunyuan3DGenerator] Downloading hy3dshape source from GitHub…")
        with urllib.request.urlopen(_GITHUB_ZIP, timeout=180) as resp:
            data = resp.read()
        print("[Hunyuan3DGenerator] Extracting hy3dshape…")

        prefix = "Hunyuan3D-2.1-main/hy3dshape/"
        strip  = "Hunyuan3D-2.1-main/"

        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for member in zf.namelist():
                if not member.startswith(prefix):
                    continue
                rel    = member[len(strip):]   # e.g. "hy3dshape/pipelines.py"
                target = dest / rel
                if member.endswith("/"):
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(zf.read(member))

        print(f"[Hunyuan3DGenerator] hy3dshape extracted to {dest}.")

    # ------------------------------------------------------------------ #
    # Parameter schema
    # ------------------------------------------------------------------ #

    @classmethod
    def params_schema(cls) -> list:
        return [
            {
                "id":      "num_inference_steps",
                "label":   "Quality",
                "type":    "select",
                "default": 50,
                "options": [
                    {"value": 20,  "label": "Fast (20 steps)"},
                    {"value": 50,  "label": "Balanced (50 steps)"},
                    {"value": 100, "label": "High (100 steps)"},
                ],
            },
        ]
