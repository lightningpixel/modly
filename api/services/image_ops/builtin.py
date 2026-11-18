"""Built-in image operations."""

from pathlib import Path
from typing import Any, Mapping

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from . import birefnet, framing
from .outputs import png_bytes, sanitize_stem, write_new_files
from .requirements import BIREFNET_LITE, ONNXRUNTIME
from .types import ImageOp, ImageOpContext, ImageOpExecutionError, ImageOpInputError, ImageOpResult


def load_image(path: Path) -> Image.Image:
    """Open an image upright (EXIF orientation applied), fully decoded."""
    try:
        with Image.open(path) as opened:
            image = ImageOps.exif_transpose(opened)
            image.load()
            return image
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ImageOpInputError(f"Cannot read image {path.name}: {exc}") from exc


def _has_alpha(image: Image.Image) -> bool:
    """Whether the image can hold transparency: an alpha channel, or a palette /
    colour-key entry (PNG tRNS on P, RGB or L images). Reads no pixels."""
    return image.mode in ("RGBA", "LA", "PA", "RGBa", "La") or "transparency" in image.info


def _alpha_u8(image: Image.Image) -> np.ndarray | None:
    """The input's own alpha channel (uint8), None when it has no transparency."""
    if not _has_alpha(image):
        return None
    return np.asarray(image.convert("RGBA").getchannel("A"))


def _source_alpha(image: Image.Image) -> np.ndarray | None:
    """The input's own transparency in [0, 1], if it has any."""
    alpha = _alpha_u8(image)
    return None if alpha is None else alpha.astype(np.float32) / 255.0


def remove_background(input_path: Path, params: Mapping[str, Any], context: ImageOpContext) -> ImageOpResult:
    image = load_image(input_path)
    rgb = image.convert("RGB")

    try:
        session = birefnet.session_cache.get(BIREFNET_LITE.path)
        alpha = birefnet.predict_alpha(session, rgb)
    except Exception as exc:
        raise ImageOpExecutionError(f"Background removal failed: {exc}") from exc

    alpha = birefnet.apply_edge_threshold(alpha, float(params.get("edge_threshold", 0.0)))
    source_alpha = _source_alpha(image)
    if source_alpha is not None:
        # Already-transparent pixels stay transparent.
        alpha = alpha * source_alpha
    mask = Image.fromarray(birefnet.to_uint8(alpha))  # 2D uint8 -> mode "L"

    cutout = rgb.copy()
    cutout.putalpha(mask)

    out_path, mask_path = write_new_files(
        context.images_dir,
        sanitize_stem(input_path.name),
        [("nobg", png_bytes(cutout)), ("mask", png_bytes(mask))],
    )
    return ImageOpResult(
        path=out_path,
        mask_path=mask_path,
        details={"width": rgb.width, "height": rgb.height},
    )


REMOVE_BACKGROUND = ImageOp(
    id="remove_background",
    label="Remove background",
    params_schema=(
        {
            "id": "edge_threshold",
            "label": "Edge hardness",
            "type": "float",
            "default": 0.0,
            "min": 0.0,
            "max": 0.95,
            "step": 0.05,
            "tooltip": (
                "0 keeps soft, natural edges (hair, fur, blur). "
                "Raise it to get crisper edges and drop faint leftovers of the background; "
                "too high can eat into thin details of the subject."
            ),
        },
    ),
    fn=remove_background,
    requirements=(ONNXRUNTIME, BIREFNET_LITE),
)


def _edge_param(param_id: str, label: str) -> dict[str, Any]:
    return {
        "id": param_id,
        "label": label,
        "type": "float",
        "default": 0.0,
        "min": 0.0,
        "max": 99.0,
        "step": 0.1,
        "tooltip": f"Percentage of the image cut off the {param_id} edge.",
    }


def crop(input_path: Path, params: Mapping[str, Any], context: ImageOpContext) -> ImageOpResult:
    image = load_image(input_path)
    image = image.convert("RGBA" if _has_alpha(image) else "RGB")
    left, top = params.get("left", 0), params.get("top", 0)
    right, bottom = params.get("right", 0), params.get("bottom", 0)
    if left + right >= 100 or top + bottom >= 100:
        raise ImageOpInputError("Nothing left to crop: the frame is empty.")
    box = framing.crop_box(image.width, image.height, left, top, right, bottom)
    cropped = image.crop(box)
    (out_path,) = write_new_files(context.images_dir, sanitize_stem(input_path.name), [("crop", png_bytes(cropped))])
    return ImageOpResult(path=out_path, details={"width": cropped.width, "height": cropped.height, "box": list(box)})


CROP = ImageOp(
    id="crop",
    label="Crop",
    params_schema=(
        _edge_param("left", "Left %"),
        _edge_param("top", "Top %"),
        _edge_param("right", "Right %"),
        _edge_param("bottom", "Bottom %"),
    ),
    fn=crop,
)


def auto_frame(input_path: Path, params: Mapping[str, Any], context: ImageOpContext) -> ImageOpResult:
    image = load_image(input_path)
    alpha = _alpha_u8(image)
    # An alpha channel with no transparent pixel (clipboard pastes, screenshots)
    # is an opaque photo: framing it would only letterbox the whole picture.
    if alpha is None or not (alpha <= framing.SUBJECT_ALPHA_THRESHOLD).any():
        raise ImageOpInputError("Auto-frame needs a transparent background: remove the background first.")
    bbox = framing.subject_bbox(alpha)
    if bbox is None:
        raise ImageOpInputError("Auto-frame found no subject: the image is fully transparent.")
    size = int(params.get("size", 1024))
    framed = framing.frame_square(image, bbox, size, float(params.get("margin", 10)))
    (out_path,) = write_new_files(context.images_dir, sanitize_stem(input_path.name), [("framed", png_bytes(framed))])
    return ImageOpResult(path=out_path, details={"width": size, "height": size, "subject_box": list(bbox)})


AUTO_FRAME = ImageOp(
    id="auto_frame",
    label="Auto-frame",
    params_schema=(
        {
            "id": "margin",
            "label": "Margin %",
            "type": "int",
            "default": 10,
            "min": 0,
            "max": 40,
            "step": 1,
            "tooltip": "Empty space kept around the subject on every side, as a percentage of the square.",
        },
        {
            "id": "size",
            "label": "Resolution",
            "type": "select",
            "default": 1024,
            "options": [
                {"value": 512, "label": "512 × 512"},
                {"value": 768, "label": "768 × 768"},
                {"value": 1024, "label": "1024 × 1024"},
                {"value": 2048, "label": "2048 × 2048"},
            ],
            "tooltip": "Size of the square image written, and sent to Generate as is.",
        },
    ),
    fn=auto_frame,
)

BUILTIN_IMAGE_OPS = (CROP, REMOVE_BACKGROUND, AUTO_FRAME)
