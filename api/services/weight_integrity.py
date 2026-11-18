"""Recognise a model load that failed because a weight file on disk is truncated.

Older builds could rename a partially downloaded file into place, and the model
then looked installed while its weights could never load. The loader's own
error is a deep traceback; this turns it into something the user can act on.
"""
import re
from typing import Optional

# Substrings that only appear when a weight file's bytes are cut short or garbled.
_TRUNCATED_WEIGHT_SIGNATURES = (
    # safetensors: header longer than the file, or a file shorter than its header says
    "Error while deserializing header",
    # torch.load on a cut-off .bin/.pt/.ckpt zip archive
    "failed finding central directory",
)

_CHECKPOINT_PATH = re.compile(
    r"Unable to load weights from checkpoint file for '([^']+)'"
)


class IncompleteModelWeightsError(RuntimeError):
    """A model's weight files on disk are incomplete; its message is user-facing."""


def incomplete_weights_message(model_name: str, error: BaseException) -> Optional[str]:
    """A short, actionable message when ``error`` comes from truncated weights, else None."""
    text = str(error)
    if not any(signature in text for signature in _TRUNCATED_WEIGHT_SIGNATURES):
        return None
    match = _CHECKPOINT_PATH.search(text)
    detail = f" ({match.group(1)})" if match else ""
    return (
        f"The model files for {model_name} are incomplete or corrupted{detail}, "
        "most likely from an interrupted download. Open the Models page, remove "
        "this node's weights, then install them again."
    )
