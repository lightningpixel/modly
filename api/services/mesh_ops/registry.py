"""Registry and dispatcher for mesh-editing operations."""

import re
from copy import deepcopy
from math import isfinite
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from .types import MeshOp, MeshOpContext, MeshOpNotFoundError, MeshOpResult


_OP_ID = re.compile(r"^[a-z][a-z0-9_-]*$")


def _apply_numeric_bounds(
    parameter_id: str,
    value: Any,
    schema: Mapping[str, Any],
) -> Any:
    """Clamp a supplied numeric value to the bounds declared by its schema."""
    minimum = schema.get("min")
    maximum = schema.get("max")
    if minimum is None and maximum is None:
        return value

    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"Parameter {parameter_id!r} must be numeric")
    if isinstance(value, float) and not isfinite(value):
        raise ValueError(f"Parameter {parameter_id!r} must be finite")

    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def _validate_param(
    parameter_id: str,
    value: Any,
    schema: Mapping[str, Any],
) -> Any:
    """Validate (and where applicable, clamp) a supplied param against its schema."""
    param_type = schema.get("type")

    if param_type == "boolean":
        if not isinstance(value, bool):
            raise TypeError(f"Parameter {parameter_id!r} must be a boolean")
        return value

    if param_type == "select":
        allowed = {option["value"] for option in schema.get("options", [])}
        if allowed and value not in allowed:
            raise ValueError(
                f"Parameter {parameter_id!r} must be one of {sorted(allowed)}"
            )
        return value

    return _apply_numeric_bounds(parameter_id, value, schema)


class MeshOpsRegistry:
    """Stores mesh operations and provides one invocation path for every caller."""

    def __init__(self, operations: Iterable[MeshOp] = ()) -> None:
        self._operations: dict[str, MeshOp] = {}
        for operation in operations:
            self.register(operation)

    def register(self, operation: MeshOp) -> None:
        if not _OP_ID.fullmatch(operation.id):
            raise ValueError(f"Invalid mesh operation id: {operation.id!r}")
        if operation.id in self._operations:
            raise ValueError(f"Duplicate mesh operation id: {operation.id!r}")
        self._operations[operation.id] = operation

    def get(self, operation_id: str) -> MeshOp:
        try:
            return self._operations[operation_id]
        except KeyError as exc:
            raise MeshOpNotFoundError(operation_id) from exc

    def describe(self) -> list[dict[str, Any]]:
        return [operation.describe() for operation in self._operations.values()]

    def run(
        self,
        operation_id: str,
        input_path: Path,
        params: Optional[Mapping[str, Any]],
        context: MeshOpContext,
    ) -> MeshOpResult:
        operation = self.get(operation_id)
        path = Path(input_path)
        if not path.is_file():
            raise FileNotFoundError(f"Input mesh not found: {path}")

        return operation.fn(path, self.resolve_params(operation_id, params), context)

    def resolve_params(
        self,
        operation_id: str,
        params: Optional[Mapping[str, Any]],
    ) -> dict[str, Any]:
        """Apply an operation's schema defaults, then validate and clamp params."""
        operation = self.get(operation_id)
        resolved_params = {
            schema["id"]: deepcopy(schema["default"])
            for schema in operation.params_schema
            if "id" in schema and "default" in schema
        }
        if params:
            resolved_params.update(params)

        for schema in operation.params_schema:
            parameter_id = schema.get("id")
            if parameter_id not in resolved_params:
                continue
            resolved_params[parameter_id] = _validate_param(
                parameter_id,
                resolved_params[parameter_id],
                schema,
            )

        return resolved_params
