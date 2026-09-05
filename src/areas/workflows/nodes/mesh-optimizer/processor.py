"""Thin workflow adapter for the shared meshoptimizer operation."""

import os
import sys
from pathlib import Path


api_dir = os.environ.get("MODLY_API_DIR")
if not api_dir:
    for parent in Path(__file__).resolve().parents:
        candidate = parent / "api"
        if candidate.is_dir():
            api_dir = str(candidate)
            break
if api_dir and api_dir not in sys.path:
    sys.path.insert(0, api_dir)

from services.mesh_ops.processor import run_processor


if __name__ == "__main__":
    run_processor("decimate", "mesh-optimizer")
