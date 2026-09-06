"""Registry and dispatcher for mesh-editing operations."""

import re
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional

from .types import MeshOp, MeshOpContext, MeshOpNotFoundError, MeshOpResult


_OP_ID = re.compile(r"^[a-z][a-z0-9_-]*$")


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

        resolved_params = {
            schema["id"]: deepcopy(schema["default"])
            for schema in operation.params_schema
            if "id" in schema and "default" in schema
        }
        if params:
            resolved_params.update(params)

        return operation.fn(path, resolved_params, context)
