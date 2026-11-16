"""Built-in image operations."""

from pathlib import Path
from typing import Any, Mapping

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from . import birefnet
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


def _source_alpha(image: Image.Image) -> np.ndarray | None:
    """The input's own transparency in [0, 1], if it has any."""
    if image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info):
        return np.asarray(image.convert("RGBA").getchannel("A"), dtype=np.float32) / 255.0
    return None


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

BUILTIN_IMAGE_OPS = (REMOVE_BACKGROUND,)
