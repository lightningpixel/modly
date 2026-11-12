"""Write new vertex positions/normals into a copy of a GLB, leaving the rest intact.

The sculpt tool edits geometry in the viewer and sends back, per glTF primitive,
the new POSITION (and optionally NORMAL) arrays. Re-exporting through trimesh
would lose extensions and rewrite materials, so instead the GLB is patched at
the container level: the new data is appended to the BIN chunk as fresh
bufferViews + accessors and the primitive's attributes are repointed to them.
Existing accessors are never mutated (they may be shared with other primitives
or morph targets); the old data is simply left unreferenced.
"""

from __future__ import annotations

import base64
import binascii
import json
import math
import struct
import sys
from array import array
from dataclasses import dataclass
from pathlib import Path

_GLB_MAGIC = 0x46546C67      # "glTF"
_CHUNK_JSON = 0x4E4F534A     # "JSON"
_CHUNK_BIN = 0x004E4942      # "BIN\0"
_FLOAT = 5126
_ARRAY_BUFFER = 34962
_DRACO = "KHR_draco_mesh_compression"


class GlbPatchError(ValueError):
    """The GLB or a patch is invalid; the message is safe to show to the user."""


@dataclass(frozen=True)
class VertexPatch:
    mesh: int
    primitive: int
    positions: str               # base64, little-endian float32, count * 3
    normals: str | None = None   # same format, optional


def patch_glb_file(input_path: Path, output_path: Path, patches: list[VertexPatch]) -> None:
    data = patch_glb_bytes(Path(input_path).read_bytes(), patches)
    Path(output_path).write_bytes(data)


def patch_glb_bytes(data: bytes, patches: list[VertexPatch]) -> bytes:
    if not patches:
        raise GlbPatchError("At least one patch is required")

    gltf, binary = _parse_glb(data)
    buffers = gltf.setdefault("buffers", [])
    if binary is None:
        if buffers:
            raise GlbPatchError("GLB has no BIN chunk but declares external buffers")
        buffers.append({"byteLength": 0})
        binary = b""
    elif not buffers or "uri" in buffers[0]:
        raise GlbPatchError("GLB BIN chunk is not bound to buffers[0]")

    # GLB BIN chunk may be padded beyond the declared buffer length; append after it.
    out = bytearray(binary)
    meshes = gltf.get("meshes") or []
    accessors = gltf.setdefault("accessors", [])
    views = gltf.setdefault("bufferViews", [])

    for patch in patches:
        primitive = _primitive(meshes, patch.mesh, patch.primitive)
        if _DRACO in (primitive.get("extensions") or {}):
            raise GlbPatchError(
                f"mesh {patch.mesh} primitive {patch.primitive} is Draco-compressed "
                f"({_DRACO}); sculpting Draco meshes is not supported"
            )
        attributes = primitive.get("attributes") or {}
        position_index = attributes.get("POSITION")
        if not isinstance(position_index, int) or not 0 <= position_index < len(accessors):
            raise GlbPatchError(f"mesh {patch.mesh} primitive {patch.primitive} has no POSITION accessor")
        count = int(accessors[position_index].get("count", 0))

        label = f"mesh {patch.mesh} primitive {patch.primitive}"
        positions_raw, positions = _decode(patch.positions, count, f"{label} positions")
        normals_raw = None
        if patch.normals is not None:
            normals_raw, _ = _decode(patch.normals, count, f"{label} normals")

        old_normal = attributes.get("NORMAL")
        new_position = _append_accessor(
            out, views, accessors, positions_raw, count, bounds=_bounds(positions),
        )
        new_normal = None
        if normals_raw is not None:
            new_normal = _append_accessor(out, views, accessors, normals_raw, count)

        # The viewer loads an accessor once and shares it between the primitives
        # using it, so the stroke moved all of them: repoint them all, or the
        # unpatched ones snap back and the mesh tears. Normals follow only where
        # they were shared as well.
        for other in _primitives_using(meshes, "POSITION", position_index):
            other_attributes = dict(other.get("attributes") or {})
            other_attributes["POSITION"] = new_position
            if new_normal is not None and other_attributes.get("NORMAL") == old_normal:
                other_attributes["NORMAL"] = new_normal
            other["attributes"] = other_attributes

    buffers[0]["byteLength"] = len(out)
    return _build_glb(gltf, bytes(out))


# ---------------------------------------------------------------------------

def _parse_glb(data: bytes) -> tuple[dict, bytes | None]:
    if len(data) < 20:
        raise GlbPatchError("Not a valid GLB file (too short)")
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != _GLB_MAGIC or version != 2:
        raise GlbPatchError("Not a valid GLB 2.0 file")
    if length > len(data):
        raise GlbPatchError("GLB file is truncated")

    json_len, json_type = struct.unpack_from("<II", data, 12)
    if json_type != _CHUNK_JSON or 20 + json_len > length:
        raise GlbPatchError("GLB is missing its JSON chunk")
    try:
        gltf = json.loads(data[20:20 + json_len].decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise GlbPatchError(f"GLB JSON chunk is invalid: {exc}") from exc
    if not isinstance(gltf, dict):
        raise GlbPatchError("GLB JSON chunk is not an object")

    offset = 20 + json_len
    binary = None
    if offset + 8 <= length:
        bin_len, bin_type = struct.unpack_from("<II", data, offset)
        if bin_type == _CHUNK_BIN:
            if offset + 8 + bin_len > length:
                raise GlbPatchError("GLB BIN chunk is truncated")
            binary = data[offset + 8:offset + 8 + bin_len]
    return gltf, binary


def _build_glb(gltf: dict, binary: bytes) -> bytes:
    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * (-len(json_bytes) % 4)
    binary += b"\0" * (-len(binary) % 4)
    body = (
        struct.pack("<II", len(json_bytes), _CHUNK_JSON) + json_bytes
        + struct.pack("<II", len(binary), _CHUNK_BIN) + binary
    )
    return struct.pack("<III", _GLB_MAGIC, 2, 12 + len(body)) + body


def _primitive(meshes: list, mesh: int, primitive: int) -> dict:
    if not 0 <= mesh < len(meshes):
        raise GlbPatchError(f"mesh {mesh} does not exist (GLB has {len(meshes)} meshes)")
    primitives = meshes[mesh].get("primitives") or []
    if not 0 <= primitive < len(primitives):
        raise GlbPatchError(
            f"primitive {primitive} does not exist in mesh {mesh} "
            f"({len(primitives)} primitives)"
        )
    return primitives[primitive]


def _primitives_using(meshes: list, attribute: str, accessor: int) -> list[dict]:
    return [
        primitive
        for mesh in meshes
        for primitive in (mesh.get("primitives") or [])
        if (primitive.get("attributes") or {}).get(attribute) == accessor
    ]


def _decode(encoded: str, count: int, label: str) -> tuple[bytes, array]:
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise GlbPatchError(f"{label}: invalid base64 ({exc})") from exc
    if len(raw) % 4:
        raise GlbPatchError(f"{label}: byte length {len(raw)} is not a multiple of 4")
    values = array("f")
    values.frombytes(raw)
    if sys.byteorder == "big":
        values.byteswap()
    if len(values) != count * 3:
        raise GlbPatchError(f"{label}: got {len(values)} floats, expected {count * 3} ({count} vertices x 3)")
    if not all(map(math.isfinite, values)):
        raise GlbPatchError(f"{label}: contains non-finite values (NaN or infinity)")
    return raw, values


def _bounds(values: array) -> tuple[list[float], list[float]]:
    if not values:
        return [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]
    columns = [values[axis::3] for axis in range(3)]
    return [min(c) for c in columns], [max(c) for c in columns]


def _append_accessor(
    out: bytearray,
    views: list,
    accessors: list,
    raw: bytes,
    count: int,
    bounds: tuple[list[float], list[float]] | None = None,
) -> int:
    out.extend(b"\0" * (-len(out) % 4))
    views.append({
        "buffer": 0,
        "byteOffset": len(out),
        "byteLength": len(raw),
        "target": _ARRAY_BUFFER,
    })
    out.extend(raw)
    accessor: dict = {
        "bufferView": len(views) - 1,
        "componentType": _FLOAT,
        "count": count,
        "type": "VEC3",
    }
    if bounds is not None:
        accessor["min"], accessor["max"] = bounds
    accessors.append(accessor)
    return len(accessors) - 1
