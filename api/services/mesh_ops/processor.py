"""Adapter between workflow process-node NDJSON and the mesh-op registry."""

import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

from . import MeshOpContext, mesh_ops_registry


def _emit(message: dict) -> None:
    print(json.dumps(message), flush=True)


def run_processor(operation_id: str, processor_id: str) -> None:
    """Read one workflow request, run a registered op, and emit its result."""
    try:
        raw = sys.stdin.readline()
        if not raw:
            raise ValueError(f"{processor_id}: missing request payload")
        data = json.loads(raw)
        input_data = data.get("input") or {}
        input_path = input_data.get("filePath")
        if not input_path or not Path(input_path).is_file():
            if processor_id == "mesh-optimizer":
                raise FileNotFoundError(
                    "mesh-optimizer: input.filePath is required"
                )
            raise FileNotFoundError(
                f"{processor_id}: input file not found: {input_path}"
            )

        workspace_dir = Path(
            data.get("workspaceDir")
            or os.environ.get("WORKSPACE_DIR")
            or Path.home() / ".modly" / "workspace"
        )
        temp_dir = Path(
            data.get("tempDir")
            or os.environ.get("TEMP_DIR")
            or tempfile.gettempdir()
        )
        context = MeshOpContext(
            workspace_dir=workspace_dir,
            temp_dir=temp_dir,
            progress_cb=lambda percent, label: _emit(
                {"type": "progress", "percent": percent, "label": label}
            ),
            log_cb=lambda message: _emit({"type": "log", "message": message}),
        )
        result = mesh_ops_registry.run(
            operation_id,
            Path(input_path),
            data.get("params") or {},
            context,
        )
        _emit(
            {
                "type": "done",
                "result": {"filePath": str(result.file_path)},
            }
        )
    except Exception as exc:
        _emit(
            {
                "type": "error",
                "message": f"{exc}\n{traceback.format_exc()}",
            }
        )
