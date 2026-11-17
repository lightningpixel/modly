"""Crop and auto-frame geometry, kept apart from file I/O so it can be tested on its own.

Generators resize and crop their input each in their own way; framing the
subject ourselves (centered, square, known margin, known resolution) means the
file sent to Generate is already what the model should see.
"""

from typing import Optional

import numpy as np
from PIL import Image

# Alpha (0..255) at or below this is background: background removal leaves a
# faint haze of near-zero alpha that must not stretch the subject's box.
SUBJECT_ALPHA_THRESHOLD = 12

Box = tuple[int, int, int, int]  # left, top, right, bottom (right/bottom exclusive)


def crop_box(width: int, height: int, left: float, top: float, right: float, bottom: float) -> Box:
    """The box left after trimming each edge by a percentage of the image side.

    Always at least 1 px wide and high.
    """
    x0 = min(width - 1, round(width * left / 100))
    y0 = min(height - 1, round(height * top / 100))
    x1 = max(x0 + 1, width - round(width * right / 100))
    y1 = max(y0 + 1, height - round(height * bottom / 100))
    return x0, y0, x1, y1


def subject_bbox(alpha: np.ndarray, threshold: int = SUBJECT_ALPHA_THRESHOLD) -> Optional[Box]:
    """Bounding box of the pixels whose alpha is above `threshold`, None if there are none."""
    visible = alpha > threshold
    rows = np.flatnonzero(visible.any(axis=1))
    cols = np.flatnonzero(visible.any(axis=0))
    if rows.size == 0:
        return None
    return int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1


def frame_square(image: Image.Image, bbox: Box, size: int, margin_percent: float) -> Image.Image:
    """The subject in `bbox`, scaled so its longer side spans `size` minus a
    margin on each side, centered on a transparent `size` x `size` canvas."""
    margin = round(size * margin_percent / 100)
    inner = max(1, size - 2 * margin)
    subject = image.convert("RGBA").crop(bbox)
    scale = inner / max(subject.width, subject.height)
    scaled_size = (
        max(1, min(inner, round(subject.width * scale))),
        max(1, min(inner, round(subject.height * scale))),
    )
    # Resample premultiplied so transparent pixels don't bleed their color into the edges.
    scaled = subject.convert("RGBa").resize(scaled_size, Image.LANCZOS).convert("RGBA")
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2))
    return canvas
