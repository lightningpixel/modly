"""
Hunyuan3DMiniGenerator — adapter for Hunyuan3D-2mini (tencent/Hunyuan3D-2mini).

Target   : consumer PCs, ≥6 GB VRAM (shape-only).
Model    : 0.6B parameters (vs 3.3B for 2.1), fast, lightweight.
Pipeline : image → rembg → DiT flow-matching → GLB
Package  : hy3dgen (github.com/Tencent/Hunyuan3D-2, ≠ hy3dshape from v2.1)

Reference: https://huggingface.co/tencent/Hunyuan3D-2mini
"""
import io
import os
import sys
import tempfile
import time
import threading
import uuid
import zipfile
from pathlib import Path
from typing import Callable, List, Optional, Union

from PIL import Image

from .base import BaseGenerator, smooth_progress

_HF_REPO_ID       = "tencent/Hunyuan3D-2mini"
_SUBFOLDER        = "hunyuan3d-dit-v2-mini"
_GITHUB_ZIP       = "https://github.com/Tencent/Hunyuan3D-2/archive/refs/heads/main.zip"
_PAINT_HF_REPO    = "tencent/Hunyuan3D-2"
_PAINT_SUBFOLDER  = "hunyuan3d-paint-v2-0-turbo"


class Hunyuan3DMiniGenerator(BaseGenerator):
    MODEL_ID     = "hunyuan3d-mini"
    DISPLAY_NAME = "Hunyuan3D 2 Mini"
    VRAM_GB      = 6

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #

    def is_downloaded(self) -> bool:
        return (self.model_dir / _SUBFOLDER).exists()

    def load(self) -> None:
        if self._model is not None:
            return

        if not self.is_downloaded():
            self._download_weights()

        self._ensure_hy3dgen()

        import torch
        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

        device = "cuda" if torch.cuda.is_available() else "cpu"
        dtype  = torch.float16 if device == "cuda" else torch.float32

        print(f"[Hunyuan3DMiniGenerator] Loading pipeline from {self.model_dir}…")
        pipeline = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(
            str(self.model_dir),
            subfolder=_SUBFOLDER,
            use_safetensors=True,
            device=device,
            dtype=dtype,
        )
        self._model = pipeline
        print(f"[Hunyuan3DMiniGenerator] Loaded on {device}.")

    def unload(self) -> None:
        super().unload()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except ImportError:
            pass

    # ------------------------------------------------------------------ #
    # Inference
    # ------------------------------------------------------------------ #

    def generate(
        self,
        image_bytes: Union[bytes, List[bytes]],
        params: dict,
        progress_cb: Optional[Callable[[int, str], None]] = None,
    ) -> Path:
        import torch

        num_steps        = int(params.get("num_inference_steps", 30))
        vert_count       = int(params.get("vertex_count", 0))
        enable_texture   = bool(params.get("enable_texture", False))
        octree_res       = int(params.get("octree_resolution", 380))
        guidance_scale   = float(params.get("guidance_scale", 5.5))
        seed             = int(params.get("seed", -1))

        # Step 1 — background removal (single or multi-view)
        view_labels = params.get("view_labels", [])
        is_multiview = isinstance(image_bytes, list) and len(image_bytes) > 1
        if is_multiview:
            self._report(progress_cb, 5, f"Removing backgrounds ({len(image_bytes)} images)…")
            processed_images = [self._preprocess(ib) for ib in image_bytes]
            if view_labels and len(view_labels) == len(processed_images):
                image = {label: img for label, img in zip(view_labels, processed_images)}
            else:
                fallback_keys = ["front", "left", "back", "right"]
                image = {fallback_keys[i]: img for i, img in enumerate(processed_images[:4])}
        elif isinstance(image_bytes, list):
            self._report(progress_cb, 5, "Removing background…")
            image = self._preprocess(image_bytes[0])
        else:
            self._report(progress_cb, 5, "Removing background…")
            image = self._preprocess(image_bytes)

        # Step 2 — shape generation
        # If texture is enabled, reserve 5-70% for shape and 70-95% for texture
        shape_end = 70 if enable_texture else 82
        self._report(progress_cb, 12, "Generating 3D shape…")
        stop_evt = threading.Event()
        if progress_cb:
            t = threading.Thread(
                target=smooth_progress,
                args=(progress_cb, 12, shape_end, "Generating 3D shape…", stop_evt),
                daemon=True,
            )
            t.start()

        try:
            with torch.no_grad():
                import torch
                generator = torch.Generator().manual_seed(seed) if seed >= 0 else None
                outputs = self._model(
                    image=image,
                    num_inference_steps=num_steps,
                    octree_resolution=octree_res,
                    guidance_scale=guidance_scale,
                    num_chunks=4000,
                    generator=generator,
                    output_type="trimesh",
                )
            mesh = outputs[0]
        finally:
            stop_evt.set()

        # Step 3 — texture (optional)
        if enable_texture:
            # Unload the shape model to free VRAM before texturing
            self._report(progress_cb, 72, "Freeing VRAM for texture model…")
            self._model = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

            mesh = self._run_texture(mesh, image, progress_cb)
        else:
            # Decimate only if no texture (texture needs the full mesh)
            if vert_count > 0 and hasattr(mesh, "vertices") and len(mesh.vertices) > vert_count:
                self._report(progress_cb, 85, "Optimizing mesh…")
                mesh = self._decimate(mesh, vert_count)

        # Step 4 — GLB export
        self._report(progress_cb, 96, "Exporting GLB…")
        self.outputs_dir.mkdir(parents=True, exist_ok=True)
        name = f"{int(time.time())}_{uuid.uuid4().hex[:8]}.glb"
        path = self.outputs_dir / name
        mesh.export(str(path))

        self._report(progress_cb, 100, "Done")
        return path

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #

    def _preprocess(self, image_bytes: bytes) -> Image.Image:
        import rembg
        return rembg.remove(Image.open(io.BytesIO(image_bytes))).convert("RGBA")

    def _run_texture(self, mesh, image: "Image.Image", progress_cb=None):
        """
        Generates PBR textures on the mesh using Hunyuan3DPaintPipeline.

        Prerequisites: compiled C++ extensions.
        If missing, a RuntimeError explains how to compile them.
        """
        import torch

        # Check that C++ extensions are available
        self._check_texgen_extensions()

        # Download texture model weights if missing
        self._report(progress_cb, 73, "Preparing texture model…")
        self._ensure_paint_weights()

        # Load the texture pipeline
        self._report(progress_cb, 78, "Loading texture model…")
        from hy3dgen.texgen import Hunyuan3DPaintPipeline

        paint_dir = self.model_dir / "_paint_weights"
        paint_pipeline = Hunyuan3DPaintPipeline.from_pretrained(
            str(paint_dir), subfolder=_PAINT_SUBFOLDER
        )

        # Reduce render resolution to speed up generation
        # (2048→1024 = 4× fewer pixels per view × 6 views)
        from hy3dgen.texgen.differentiable_renderer.mesh_render import MeshRender
        paint_pipeline.config.render_size  = 1024
        paint_pipeline.config.texture_size = 1024
        paint_pipeline.render = MeshRender(default_resolution=1024, texture_size=1024)

        # Save the preprocessed image to a temporary file
        # (the pipeline expects a path or a PIL Image depending on the version)
        tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        try:
            image.save(tmp.name)
            tmp.close()

            self._report(progress_cb, 83, "Generating textures…")
            with torch.no_grad():
                result = paint_pipeline(mesh, image=tmp.name)
        finally:
            os.unlink(tmp.name)
            # Free VRAM after texturing
            del paint_pipeline
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        # The pipeline may return a mesh directly or a list
        return result[0] if isinstance(result, (list, tuple)) else result

    def _check_texgen_extensions(self) -> None:
        """
        Checks that the C++ extensions for texture generation are compiled.
        Raises a RuntimeError with compilation instructions if missing.
        """
        try:
            from hy3dgen.texgen import Hunyuan3DPaintPipeline  # noqa: F401
        except (ImportError, OSError) as exc:
            base = self.model_dir / "_hy3dgen" / "hy3dgen" / "texgen"
            raise RuntimeError(
                "The C++ extensions for texture generation are not compiled.\n"
                "Compile them with:\n\n"
                f"  cd \"{base / 'custom_rasterizer'}\"\n"
                f"  python setup.py install\n\n"
                f"  cd \"{base / 'differentiable_renderer'}\"\n"
                f"  python setup.py install\n\n"
                f"Original error: {exc}"
            ) from exc

    def _ensure_paint_weights(self) -> None:
        """Downloads texture model weights from tencent/Hunyuan3D-2 if missing."""
        paint_dir = self.model_dir / "_paint_weights"
        # Both subfolders are required: paint (diffusion) + delight (shadow removal)
        if (paint_dir / _PAINT_SUBFOLDER).exists() and (paint_dir / "hunyuan3d-delight-v2-0").exists():
            return

        from huggingface_hub import snapshot_download
        print(f"[Hunyuan3DMiniGenerator] Downloading paint model ({_PAINT_HF_REPO})…")
        snapshot_download(
            repo_id=_PAINT_HF_REPO,
            local_dir=str(paint_dir),
            ignore_patterns=[
                # Keep: hunyuan3d-paint-v2-0-turbo/ + hunyuan3d-delight-v2-0/ + config.json
                "hunyuan3d-dit-v2-0/**",
                "hunyuan3d-dit-v2-0-fast/**",
                "hunyuan3d-dit-v2-0-turbo/**",
                "hunyuan3d-vae-v2-0/**",
                "hunyuan3d-vae-v2-0-turbo/**",
                "hunyuan3d-vae-v2-0-withencoder/**",
                "hunyuan3d-paint-v2-0/**",       # standard — not required with turbo
                "assets/**",
                "*.md", "LICENSE", "NOTICE", ".gitattributes",
            ],
        )
        print("[Hunyuan3DMiniGenerator] Paint model downloaded.")

    def _decimate(self, mesh, target_vertices: int):
        target_faces = max(4, target_vertices * 2)
        try:
            return mesh.simplify_quadric_decimation(target_faces)
        except Exception as exc:
            print(f"[Hunyuan3DMiniGenerator] Decimation skipped: {exc}")
            return mesh

    def _download_weights(self) -> None:
        from huggingface_hub import snapshot_download
        print(f"[Hunyuan3DMiniGenerator] Downloading {_HF_REPO_ID} (base variant)…")
        snapshot_download(
            repo_id=_HF_REPO_ID,
            local_dir=str(self.model_dir),
            ignore_patterns=[
                # Turbo/fast/encoder variants — not required for base inference
                "hunyuan3d-dit-v2-mini-fast/**",
                "hunyuan3d-dit-v2-mini-turbo/**",
                "hunyuan3d-vae-v2-mini-turbo/**",
                "hunyuan3d-vae-v2-mini-withencoder/**",
                "*.md", "LICENSE", "NOTICE", ".gitattributes",
            ],
        )
        print("[Hunyuan3DMiniGenerator] Download complete.")

    def _ensure_hy3dgen(self) -> None:
        """
        Makes hy3dgen importable.

        hy3dgen comes from the GitHub repo Tencent/Hunyuan3D-2 (different from the 2.1 repo).
        Structure after extraction:
            model_dir/_hy3dgen/          ← added to sys.path
            └── hy3dgen/                 ← importable package
                ├── __init__.py
                └── shapegen/
                    └── __init__.py
        """
        try:
            from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline  # noqa: F401
            return
        except ImportError:
            pass

        src_dir = self.model_dir / "_hy3dgen"
        if not (src_dir / "hy3dgen").exists():
            self._download_hy3dgen(src_dir)

        if str(src_dir) not in sys.path:
            sys.path.insert(0, str(src_dir))

        try:
            from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline  # noqa: F401
        except ImportError as exc:
            raise RuntimeError(
                f"hy3dgen still not importable after extraction to {src_dir}.\n"
                f"Check the folder contents.\n{exc}"
            ) from exc

    def _download_hy3dgen(self, dest: Path) -> None:
        """
        Extracts hy3dgen/ from the GitHub repo ZIP archive Tencent/Hunyuan3D-2.

        Structure in the ZIP:
            Hunyuan3D-2-main/
            └── hy3dgen/        ← extracted to dest/hy3dgen/
                ├── __init__.py
                └── shapegen/

        After extraction, dest/ will contain hy3dgen/ → importable via sys.path.
        """
        import urllib.request

        dest.mkdir(parents=True, exist_ok=True)
        print("[Hunyuan3DMiniGenerator] Downloading hy3dgen source from GitHub…")
        with urllib.request.urlopen(_GITHUB_ZIP, timeout=180) as resp:
            data = resp.read()
        print("[Hunyuan3DMiniGenerator] Extracting hy3dgen…")

        prefix = "Hunyuan3D-2-main/hy3dgen/"
        strip  = "Hunyuan3D-2-main/"

        with zipfile.ZipFile(io.BytesIO(data)) as zf:
            for member in zf.namelist():
                if not member.startswith(prefix):
                    continue
                rel    = member[len(strip):]   # e.g. "hy3dgen/shapegen/__init__.py"
                target = dest / rel
                if member.endswith("/"):
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(zf.read(member))

        print(f"[Hunyuan3DMiniGenerator] hy3dgen extracted to {dest}.")

    @classmethod
    def params_schema(cls) -> list:
        return [
            {
                "id":      "num_inference_steps",
                "label":   "Quality",
                "type":    "select",
                "default": 30,
                "options": [
                    {"value": 10, "label": "Fast (10 steps)"},
                    {"value": 30, "label": "Balanced (30 steps)"},
                    {"value": 50, "label": "High (50 steps)"},
                ],
            },
            {
                "id":      "octree_resolution",
                "label":   "Mesh Resolution",
                "type":    "select",
                "default": 380,
                "options": [
                    {"value": 256, "label": "Low (256)"},
                    {"value": 380, "label": "Medium (380)"},
                    {"value": 512, "label": "High (512)"},
                ],
            },
            {
                "id":      "guidance_scale",
                "label":   "Guidance Scale",
                "type":    "float",
                "default": 5.5,
                "min":     1.0,
                "max":     10.0,
            },
            {
                "id":      "seed",
                "label":   "Seed",
                "type":    "int",
                "default": -1,
                "min":     -1,
                "max":     2147483647,
            },
        ]
