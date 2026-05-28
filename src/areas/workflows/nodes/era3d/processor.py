"""
Era3D Multi-View Generator — Modly built-in process extension.

Takes a single image and generates 6 consistent multi-view images
(front, back, left, right, top-front, top-back) as a vertical strip PNG.

The output strip can be fed directly into Trellis2's Generate Mesh node
for significantly improved geometry on hands, back surfaces, and thin features.

Model: pengHTYX/MacLab-Era3D-512-6view (HuggingFace)
Paper: Era3D — NeurIPS 2024 (https://arxiv.org/abs/2405.11616)

Protocol: reads one JSON line from stdin, writes JSON lines to stdout.
  stdin : { input, params, workspaceDir, tempDir }
  stdout: { type: "progress"|"log"|"done"|"error", ... }
"""

import json
import os
import sys
import base64
from pathlib import Path
from time import time


# ── Protocol helpers ──────────────────────────────────────────────────────────

def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)

def progress(pct: int, label: str) -> None:
    emit({"type": "progress", "percent": pct, "label": label})

def log(msg: str) -> None:
    emit({"type": "log", "message": msg})

def done(file_path: str) -> None:
    emit({"type": "done", "result": {"filePath": file_path}})

def error(msg: str) -> None:
    emit({"type": "error", "message": msg})


# ── Dependency check & lazy install ──────────────────────────────────────────

def ensure_dependencies() -> bool:
    """Check that diffusers, transformers, accelerate, and PIL are available."""
    missing = []
    for pkg in ("diffusers", "transformers", "accelerate", "PIL", "torch", "einops"):
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)
    if missing:
        error(
            f"Era3D requires the following packages to be installed in the extension venv: "
            f"{', '.join(missing)}. "
            f"Please run: pip install diffusers transformers accelerate Pillow torch torchvision einops"
        )
        return False
    return True


# ── Image helpers ─────────────────────────────────────────────────────────────

def load_image(path_or_b64: str, is_base64: bool = False):
    """Load a PIL Image from a file path or base64 string."""
    from PIL import Image
    import io
    if is_base64:
        img_bytes = base64.b64decode(path_or_b64)
        return Image.open(io.BytesIO(img_bytes)).convert("RGBA")
    return Image.open(path_or_b64).convert("RGBA")


def remove_background(image):
    """
    Simple background removal: assumes roughly uniform background.
    For best results the input should already have a clean background.
    Returns an RGBA image with background made transparent.
    """
    from PIL import Image
    import numpy as np

    img_array = np.array(image)
    if img_array.shape[2] == 4:
        return image  # Already has alpha

    # Convert to RGBA
    rgba = Image.new("RGBA", image.size)
    rgba.paste(image)
    return rgba


def preprocess_image(image, crop_size: int = 420):
    """
    Preprocess input image for Era3D:
    - Remove background (alpha composite on white)
    - Center crop to square
    - Resize to crop_size
    Returns PIL Image (RGB).
    """
    from PIL import Image
    import numpy as np

    # Ensure RGBA
    if image.mode != "RGBA":
        image = image.convert("RGBA")

    # Composite onto white background
    background = Image.new("RGBA", image.size, (255, 255, 255, 255))
    background.paste(image, mask=image.split()[3])
    image = background.convert("RGB")

    # Center crop to square
    w, h = image.size
    min_dim = min(w, h)
    left   = (w - min_dim) // 2
    top    = (h - min_dim) // 2
    image  = image.crop((left, top, left + min_dim, top + min_dim))

    # Resize to crop_size
    image = image.resize((crop_size, crop_size), Image.LANCZOS)
    return image


def build_strip(views: list, view_size: int) -> object:
    """
    Stack 6 view images into a vertical strip PNG.
    Era3D outputs views in order:
      0: front-right (azimuth +30°, elevation -30°)
      1: back-right  (azimuth +90°, elevation +20°)
      2: back        (azimuth +150°, elevation -30°)
      3: back-left   (azimuth +210°, elevation +20°)
      4: front-left  (azimuth +270°, elevation -30°)
      5: top         (azimuth +330°, elevation +20°)
    """
    from PIL import Image
    strip = Image.new("RGB", (view_size, view_size * 6))
    for i, view in enumerate(views):
        v = view.resize((view_size, view_size), Image.LANCZOS)
        strip.paste(v, (0, i * view_size))
    return strip


# ── Era3D pipeline loader ─────────────────────────────────────────────────────

def load_era3d_pipeline(models_dir: Path, output_size: int = 512):
    """
    Load the Era3D diffusion pipeline from local cache or HuggingFace.
    Model: pengHTYX/MacLab-Era3D-512-6view
    """
    import torch
    from diffusers import EulerAncestralDiscreteScheduler

    model_id   = "pengHTYX/MacLab-Era3D-512-6view"
    cache_dir  = models_dir / "era3d"
    cache_dir.mkdir(parents=True, exist_ok=True)

    log(f"Loading Era3D model from {cache_dir} (downloads from HuggingFace on first run)…")

    # Era3D uses a custom pipeline — try to import it
    # It ships with the diffusers extras or can be loaded via pipeline_class
    try:
        from diffusers import DiffusionPipeline
        pipe = DiffusionPipeline.from_pretrained(
            model_id,
            cache_dir=str(cache_dir),
            torch_dtype=torch.float16,
            trust_remote_code=True,
        )
    except Exception as e:
        raise RuntimeError(
            f"Failed to load Era3D pipeline: {e}\n"
            f"Make sure diffusers>=0.27.0 is installed and you have internet access for the first download."
        )

    # Use Euler Ancestral scheduler for best quality
    pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(
        pipe.scheduler.config, timestep_spacing="trailing"
    )

    device = "cuda" if __import__("torch").cuda.is_available() else "cpu"
    log(f"Using device: {device}")
    pipe = pipe.to(device)

    # Enable memory optimisations for 24GB VRAM (3090)
    if device == "cuda":
        try:
            pipe.enable_xformers_memory_efficient_attention()
        except Exception:
            pass  # xformers not installed — fine, sdpa will be used

    return pipe, device


# ── Main generation ───────────────────────────────────────────────────────────

def generate_views(image, pipe, device: str, num_steps: int, guidance_scale: float, output_size: int):
    """
    Run Era3D inference to generate 6 multi-view images.
    Returns list of 6 PIL Images.
    """
    import torch

    progress(40, "Running Era3D multi-view diffusion…")

    with torch.no_grad():
        result = pipe(
            image,
            num_inference_steps=num_steps,
            guidance_scale=guidance_scale,
            output_type="pil",
        )

    # Era3D returns images in result.images — 6 views per input
    views = result.images
    if not views:
        raise RuntimeError("Era3D returned no images")

    # Resize to output_size if needed
    views = [v.resize((output_size, output_size), __import__("PIL").Image.LANCZOS) for v in views[:6]]
    return views


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    raw  = sys.stdin.readline()
    data = json.loads(raw)

    input_data    = data.get("input", {})
    params        = data.get("params", {})
    workspace_dir = data.get("workspaceDir", "")
    models_dir    = Path(os.environ.get("MODELS_DIR", Path.home() / ".modly" / "models"))

    # ── Params ────────────────────────────────────────────────────────────────
    num_steps      = int(params.get("num_steps", 40))
    guidance_scale = float(params.get("guidance_scale", 3.0))
    crop_size      = int(params.get("crop_size", 420))
    output_size    = int(params.get("output_size", 512))

    # ── Input ─────────────────────────────────────────────────────────────────
    input_path = input_data.get("filePath")
    if not input_path or not Path(input_path).is_file():
        error(f"era3d: input image not found: {input_path}")
        return

    progress(5, "Checking dependencies…")
    if not ensure_dependencies():
        return

    progress(10, "Loading input image…")
    try:
        image = load_image(input_path)
    except Exception as e:
        error(f"era3d: failed to load image: {e}")
        return

    progress(15, "Preprocessing image…")
    image = preprocess_image(image, crop_size=crop_size)
    log(f"Input preprocessed to {image.size[0]}×{image.size[1]} RGB")

    progress(20, "Loading Era3D model (first run downloads ~8GB)…")
    try:
        pipe, device = load_era3d_pipeline(models_dir, output_size=output_size)
    except Exception as e:
        error(f"era3d: model load failed: {e}")
        return

    progress(40, "Generating 6 views…")
    try:
        views = generate_views(image, pipe, device, num_steps, guidance_scale, output_size)
    except Exception as e:
        error(f"era3d: generation failed: {e}")
        return

    progress(85, "Building view strip…")
    strip = build_strip(views, output_size)

    # ── Save output ───────────────────────────────────────────────────────────
    out_dir = Path(workspace_dir) / "Workflows"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = str(out_dir / f"era3d-views-{int(time() * 1000)}.png")

    try:
        strip.save(out_path, "PNG")
    except Exception as e:
        error(f"era3d: failed to save output: {e}")
        return

    progress(100, "Done — 6 views generated")
    log(f"Output: {out_path} ({output_size}×{output_size * 6}px vertical strip, 6 views)")
    done(out_path)


if __name__ == "__main__":
    main()
