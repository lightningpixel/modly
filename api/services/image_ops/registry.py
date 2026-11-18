"""Registry and dispatcher for image operations.

Param handling follows services.mesh_ops.registry (same schema format: defaults,
then type checks and clamping to min/max). It is not imported from there: that
package pulls in trimesh and the whole mesh stack at import.
"""

import re
from copy import deepcopy
from math import isfinite
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Optional

from .types import (
    ImageOp,
    ImageOpContext,
    ImageOpNotFoundError,
    ImageOpNotReadyError,
    ImageOpResult,
)


_OP_ID = re.compile(r"^[a-z][a-z0-9_-]*$")


def _validate_param(parameter_id: str, value: Any, schema: Mapping[str, Any]) -> Any:
    """Validate a supplied param against its schema; clamp numbers to min/max."""
    param_type = schema.get("type")

    if param_type == "boolean":
        if not isinstance(value, bool):
            raise TypeError(f"Parameter {parameter_id!r} must be a boolean")
        return value

    if param_type == "select":
        allowed = {option["value"] for option in schema.get("options", [])}
        if allowed and value not in allowed:
            raise ValueError(f"Parameter {parameter_id!r} must be one of {sorted(allowed)}")
        return value

    if param_type in ("int", "float"):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError(f"Parameter {parameter_id!r} must be numeric")
        if isinstance(value, float) and not isfinite(value):
            raise ValueError(f"Parameter {parameter_id!r} must be finite")
        if param_type == "int":
            if isinstance(value, float) and not value.is_integer():
                raise TypeError(f"Parameter {parameter_id!r} must be an integer")
            value = int(value)
        else:
            value = float(value)
        if schema.get("min") is not None:
            value = max(schema["min"], value)
        if schema.get("max") is not None:
            value = min(schema["max"], value)
        return value

    return value


class ImageOpsRegistry:
    def __init__(self, operations: Iterable[ImageOp] = ()) -> None:
        self._operations: dict[str, ImageOp] = {}
        for operation in operations:
            self.register(operation)

    def register(self, operation: ImageOp) -> None:
        if not _OP_ID.fullmatch(operation.id):
            raise ValueError(f"Invalid image operation id: {operation.id!r}")
        if operation.id in self._operations:
            raise ValueError(f"Duplicate image operation id: {operation.id!r}")
        self._operations[operation.id] = operation

    def get(self, operation_id: str) -> ImageOp:
        try:
            return self._operations[operation_id]
        except KeyError as exc:
            raise ImageOpNotFoundError(operation_id) from exc

    def __iter__(self) -> Iterator[ImageOp]:
        return iter(self._operations.values())

    def describe(self) -> list[dict[str, Any]]:
        return [operation.describe() for operation in self._operations.values()]

    def resolve_params(
        self,
        operation_id: str,
        params: Optional[Mapping[str, Any]],
    ) -> dict[str, Any]:
        """Apply the schema defaults, then validate and clamp. Unknown keys are rejected."""
        operation = self.get(operation_id)
        known = {schema["id"] for schema in operation.params_schema if "id" in schema}
        unknown = sorted(set(params or {}) - known)
        if unknown:
            raise ValueError(f"Unknown parameter(s) for {operation_id}: {', '.join(unknown)}")

        resolved = {
            schema["id"]: deepcopy(schema["default"])
            for schema in operation.params_schema
            if "id" in schema and "default" in schema
        }
        resolved.update(params or {})
        for schema in operation.params_schema:
            parameter_id = schema.get("id")
            if parameter_id in resolved:
                resolved[parameter_id] = _validate_param(parameter_id, resolved[parameter_id], schema)
        return resolved

    def run(
        self,
        operation_id: str,
        input_path: Path,
        params: Optional[Mapping[str, Any]],
        context: ImageOpContext,
    ) -> ImageOpResult:
        operation = self.get(operation_id)
        resolved = self.resolve_params(operation_id, params)
        missing = operation.missing()
        if missing:
            raise ImageOpNotReadyError(operation_id, missing)
        path = Path(input_path)
        if not path.is_file():
            raise FileNotFoundError(f"Input image not found: {path}")
        return operation.fn(path, resolved, context)
