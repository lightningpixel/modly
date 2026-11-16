"""Image operation registry (background removal, ...) used by the /image API."""

from .builtin import BUILTIN_IMAGE_OPS
from .registry import ImageOpsRegistry
from .types import (
    ImageOp,
    ImageOpContext,
    ImageOpExecutionError,
    ImageOpInputError,
    ImageOpNotFoundError,
    ImageOpNotReadyError,
    ImageOpResult,
    Requirement,
)


image_ops_registry = ImageOpsRegistry(BUILTIN_IMAGE_OPS)

__all__ = [
    "ImageOp",
    "ImageOpContext",
    "ImageOpExecutionError",
    "ImageOpInputError",
    "ImageOpNotFoundError",
    "ImageOpNotReadyError",
    "ImageOpResult",
    "ImageOpsRegistry",
    "Requirement",
    "image_ops_registry",
]
