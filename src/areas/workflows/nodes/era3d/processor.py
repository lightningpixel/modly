"""
Era3D Multi-View Generator — Modly built-in process extension.

Takes a single image and generates 6 consistent multi-view images
(front, front-right, right, back, left, front-left) as a vertical strip PNG.

Model: pengHTYX/MacLab-Era3D-512-6view (HuggingFace)
Paper: Era3D — NeurIPS 2024 (https://arxiv.org/abs/2405.11616)

Protocol: reads one JSON line from stdin, writes JSON lines to stdout.
  stdin : { input, params, workspaceDir, tempDir }
  stdout: { type: "progress"|"log"|"done"|"error", ... }
"""

import json
import os
import sys
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


# ── Locate Era3D repo ─────────────────────────────────────────────────────────

def find_era3d_repo() -> "Path | None":
    script_dir = Path(__file__).parent
    for candidate in [script_dir / "era3d-repo", script_dir / "Era3D"]:
        if (candidate / "mvdiffusion").is_dir():
            return candidate
    return None


def inject_era3d_path() -> "Path | None":
    repo = find_era3d_repo()
    if repo is None:
        error(
            "Era3D repo not found. Run setup.bat from the era3d extension directory first.\n"
            "Expected: era3d-repo/ folder with mvdiffusion/ inside it."
        )
        return None
    repo_str = str(repo)
    if repo_str not in sys.path:
        sys.path.insert(0, repo_str)
    log(f"Era3D repo: {repo_str}")
    return repo


# ── Dependency check ──────────────────────────────────────────────────────────

def ensure_dependencies() -> bool:
    missing = []
    for pkg in ("diffusers", "transformers", "accelerate", "PIL", "torch", "einops", "omegaconf", "rembg"):
        try:
            __import__(pkg)
        except ImportError:
            missing.append(pkg)
    if missing:
        error(f"Era3D requires: {', '.join(missing)}. Run setup.bat to install all dependencies.")
        return False
    return True


# ── Pipeline loader ───────────────────────────────────────────────────────────

def load_pipeline(models_dir: Path, hf_token: str | None):
    """
    Load Era3D pipeline manually to work around diffusers' inability to
    auto-resolve the custom mvdiffusion UNet from model_index.json.

    Strategy:
      1. Download all model files via snapshot_download (handles caching/auth)
      2. Temporarily patch diffusers' MODEL_MAPPING to register the custom UNet
      3. Call StableUnCLIPImg2ImgPipeline.from_pretrained on the local snapshot
    """
    import torch
    from huggingface_hub import snapshot_download
    from mvdiffusion.pipelines.pipeline_mvdiffusion_unclip import StableUnCLIPImg2ImgPipeline
    from mvdiffusion.models.unet_mv2d_condition import UNetMV2DConditionModel

    model_id  = "pengHTYX/MacLab-Era3D-512-6view"
    cache_dir = models_dir / "era3d"
    cache_dir.mkdir(parents=True, exist_ok=True)

    # ── Step 1: download snapshot ────────────────────────────────────────────
    log(f"Downloading Era3D model snapshot (first run ~8 GB)…")
    local_dir = snapshot_download(
        repo_id=model_id,
        cache_dir=str(cache_dir),
        token=hf_token or None,
    )
    log(f"Model snapshot at: {local_dir}")

    # ── Step 2: register custom UNet with diffusers ──────────────────────────
    # diffusers resolves class names in model_index.json via its own registry.
    # We inject the custom UNet so from_pretrained can find it.
    import diffusers
    import diffusers.models as diffusers_models

    if not hasattr(diffusers_models, "UNetMV2DConditionModel"):
        diffusers_models.UNetMV2DConditionModel = UNetMV2DConditionModel
        log("Registered UNetMV2DConditionModel with diffusers")

    # Also patch the diffusers top-level namespace used by pipeline loader
    if not hasattr(diffusers, "UNetMV2DConditionModel"):
        diffusers.UNetMV2DConditionModel = UNetMV2DConditionModel

    # ── Step 3: load UNet manually, then load pipeline without unet ─────────
    # from_pretrained rejects custom UNet types — load it separately and inject.
    import os
    from diffusers import DDPMScheduler, AutoencoderKL
    from transformers import CLIPImageProcessor, CLIPVisionModelWithProjection, CLIPTokenizer, CLIPTextModel
    try:
        from transformers import CLIPFeatureExtractor
    except ImportError:
        CLIPFeatureExtractor = CLIPImageProcessor

    log("Loading UNetMV2DConditionModel from snapshot…")
    unet = UNetMV2DConditionModel.from_pretrained(
        os.path.join(local_dir, "unet"),
        torch_dtype=torch.float16,
    )

    log("Loading pipeline from local snapshot…")
    pipe = StableUnCLIPImg2ImgPipeline.from_pretrained(
        local_dir,
        unet=unet,
        torch_dtype=torch.float16,
        local_files_only=True,
    )

    device = "cuda" if torch.cuda.is_available() else "cpu"
    log(f"Device: {device}")
    pipe = pipe.to(device)

    # Do NOT call enable_xformers_memory_efficient_attention() — Era3D's custom
    # attention processors (JointAttnProcessor, MVAttnProcessor) handle attention
    # internally. Enabling xformers replaces them with XFormersAttnProcessor which
    # returns None on newer diffusers and breaks the forward pass.
    log("Using sdpa attention (xformers skipped for Era3D compatibility)")

    return pipe, device


# ── Inference ─────────────────────────────────────────────────────────────────

def run_era3d(pipe, repo: Path, input_image, crop_size: int,
              num_steps: int, guidance_scale: float, seed: int, device: str):
    import torch
    from einops import rearrange
    from mvdiffusion.data.single_image_dataset import SingleImageDataset

    prompt_embeds_path = str(repo / "mvdiffusion" / "data" / "fixed_prompt_embeds_6view")
    log(f"Using prompt embeddings from: {prompt_embeds_path}")

    dataset = SingleImageDataset(
        root_dir='',
        num_views=6,
        img_wh=[512, 512],
        bg_color='white',
        crop_size=crop_size,
        single_image=input_image,
        prompt_embeds_path=prompt_embeds_path,
    )
    batch = dataset[0]

    imgs_in = torch.stack([batch['imgs_in']] * 2, dim=0)          # (2, Nv, C, H, W)
    imgs_in = rearrange(imgs_in, "B Nv C H W -> (B Nv) C H W")    # (2*Nv, C, H, W)

    normal_embeds = batch['normal_prompt_embeddings']
    color_embeds  = batch['color_prompt_embeddings']
    prompt_embeds = torch.stack([normal_embeds, color_embeds], dim=0)
    prompt_embeds = rearrange(prompt_embeds, "B Nv N C -> (B Nv) N C")

    imgs_in      = imgs_in.to(device=device, dtype=torch.float16)
    prompt_embeds = prompt_embeds.to(device=device, dtype=torch.float16)

    generator = torch.Generator(device=pipe.unet.device).manual_seed(seed)
    pipe.set_progress_bar_config(disable=True)

    progress(50, "Running Era3D diffusion…")
    with torch.no_grad():
        out = pipe(
            imgs_in,
            None,
            prompt_embeds=prompt_embeds,
            generator=generator,
            guidance_scale=guidance_scale,
            output_type='pt',
            num_images_per_prompt=1,
            num_inference_steps=num_steps,
            eta=1.0,
        ).images

    bsz = out.shape[0] // 2
    images_pred = out[bsz:]   # color views (first half = normals, skip for now)
    log(f"Era3D returned {images_pred.shape[0]} color views")
    return images_pred


# ── Build output strip ────────────────────────────────────────────────────────

def tensor_views_to_strip(views_tensor, view_size: int):
    """Convert (Nv, C, H, W) float tensor [0,1] to vertical strip PIL Image."""
    from PIL import Image
    import numpy as np

    strip = Image.new("RGB", (view_size, view_size * views_tensor.shape[0]))
    for i in range(views_tensor.shape[0]):
        arr = views_tensor[i].mul(255).add_(0.5).clamp_(0, 255)
        arr = arr.permute(1, 2, 0).to("cpu", dtype=torch.uint8 if False else None).numpy()
        arr = (arr * 255).clip(0, 255).astype("uint8") if arr.max() <= 1.0 else arr.clip(0, 255).astype("uint8")
        view_img = Image.fromarray(arr).resize((view_size, view_size), Image.LANCZOS)
        strip.paste(view_img, (0, i * view_size))
    return strip


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    import torch  # needed for tensor ops in strip builder

    raw  = sys.stdin.readline()
    data = json.loads(raw)

    input_data    = data.get("input", {})
    params        = data.get("params", {})
    workspace_dir = data.get("workspaceDir", "")
    models_dir    = Path(os.environ.get("MODELS_DIR", Path.home() / ".modly" / "models"))
    hf_token      = os.environ.get("HF_TOKEN")

    num_steps      = int(params.get("num_steps", 40))
    guidance_scale = float(params.get("guidance_scale", 3.0))
    crop_size      = int(params.get("crop_size", 420))
    output_size    = int(params.get("output_size", 512))
    seed           = int(params.get("seed", 42))

    input_path = input_data.get("filePath")
    if not input_path or not Path(input_path).is_file():
        error(f"era3d: input image not found: {input_path}")
        return

    progress(5, "Checking dependencies…")
    if not ensure_dependencies():
        return

    progress(8, "Locating Era3D repo…")
    repo = inject_era3d_path()
    if repo is None:
        return

    progress(12, "Loading input image…")
    try:
        from PIL import Image
        image = Image.open(input_path).convert("RGBA")
        log(f"Input image: {image.size[0]}x{image.size[1]}")
    except Exception as e:
        error(f"era3d: failed to load image: {e}")
        return

    progress(20, "Loading Era3D model (first run downloads ~8 GB)…")
    try:
        pipe, device = load_pipeline(models_dir, hf_token)
    except Exception as e:
        error(f"era3d: model load failed: {e}")
        return

    progress(45, "Preparing input data…")
    try:
        views_tensor = run_era3d(pipe, repo, image, crop_size, num_steps, guidance_scale, seed, device)
    except Exception as e:
        import traceback
        error(f"era3d: generation failed: {e}\n{traceback.format_exc()}")
        return

    progress(88, "Building view strip…")
    try:
        strip = tensor_views_to_strip(views_tensor, output_size)
    except Exception as e:
        error(f"era3d: strip build failed: {e}")
        return

    out_dir = Path(workspace_dir) / "Workflows"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = str(out_dir / f"era3d-views-{int(time() * 1000)}.png")

    try:
        strip.save(out_path, "PNG")
    except Exception as e:
        error(f"era3d: failed to save output: {e}")
        return

    progress(100, "Done — 6 views generated")
    log(f"Output: {out_path} ({output_size}x{output_size * views_tensor.shape[0]}px vertical strip)")
    done(out_path)


if __name__ == "__main__":
    main()
