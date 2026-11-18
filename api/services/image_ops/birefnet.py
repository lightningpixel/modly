"""BiRefNet-lite background matting on CPU through onnxruntime.

onnxruntime is installed on first use (see requirements.py), so it is only
imported inside `_create_onnx_session`, never at module import.
Pre/post-processing follows the model's preprocessor_config.json:
1024x1024 bilinear resize, x/255, ImageNet mean/std; the output is logits.
"""

import threading
from pathlib import Path
from typing import Any, Callable, Optional

import numpy as np
from PIL import Image

INPUT_SIZE = 1024
_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

SessionFactory = Callable[[Path], Any]


def _create_onnx_session(model_path: Path) -> Any:
    import onnxruntime as ort  # lazy: installed on demand

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])


class SessionCache:
    """One InferenceSession per model file, built on first use and reused.
    Tests inject a fake factory so they never need onnxruntime or the model."""

    def __init__(self, factory: SessionFactory = _create_onnx_session) -> None:
        self._factory = factory
        self._lock = threading.Lock()
        self._key: Optional[tuple[str, int]] = None
        self._session: Any = None

    def get(self, model_path: Path) -> Any:
        stat = model_path.stat()
        key = (str(model_path.resolve()), stat.st_mtime_ns)
        with self._lock:
            if self._session is None or self._key != key:
                self._session = self._factory(model_path)
                self._key = key
            return self._session

    def clear(self) -> None:
        with self._lock:
            self._session = None
            self._key = None


session_cache = SessionCache()


def preprocess(rgb: Image.Image) -> np.ndarray:
    """RGB PIL image -> float32 NCHW tensor (1, 3, 1024, 1024)."""
    resized = rgb.resize((INPUT_SIZE, INPUT_SIZE), Image.Resampling.BILINEAR)
    array = np.asarray(resized, dtype=np.float32) / 255.0
    array = (array - _MEAN) / _STD
    return np.ascontiguousarray(array.transpose(2, 0, 1)[None, ...], dtype=np.float32)


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(x, -60.0, 60.0)))


def predict_alpha(session: Any, rgb: Image.Image) -> np.ndarray:
    """Soft foreground alpha in [0, 1], float32, at the image's own size (H, W)."""
    input_name = session.get_inputs()[0].name
    outputs = session.run(None, {input_name: preprocess(rgb)})
    logits = np.asarray(outputs[0], dtype=np.float32)
    matte = _sigmoid(logits.reshape(logits.shape[-2], logits.shape[-1]))
    resized = Image.fromarray(matte.astype(np.float32)).resize(rgb.size, Image.Resampling.BILINEAR)
    return np.clip(np.asarray(resized, dtype=np.float32), 0.0, 1.0)


def apply_edge_threshold(alpha: np.ndarray, threshold: float) -> np.ndarray:
    """0 keeps the soft alpha; t > 0 hardens: clamp((a - t) / (1 - t), 0, 1)."""
    if threshold <= 0:
        return np.clip(alpha, 0.0, 1.0)
    t = min(float(threshold), 0.999)
    return np.clip((alpha - t) / (1.0 - t), 0.0, 1.0)


def to_uint8(alpha: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(alpha * 255.0), 0, 255).astype(np.uint8)
