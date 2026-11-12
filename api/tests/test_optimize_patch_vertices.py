import base64
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
import trimesh
from fastapi import HTTPException
from PIL import Image

from routers import optimize


# ---------------------------------------------------------------------------
# GLB helpers (test-side, independent from the implementation under test)
# ---------------------------------------------------------------------------

def _read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67 and version == 2 and length == len(data)
    json_len, json_type = struct.unpack_from("<II", data, 12)
    assert json_type == 0x4E4F534A and json_len % 4 == 0
    gltf = json.loads(data[20:20 + json_len])
    offset = 20 + json_len
    binary = b""
    if offset < len(data):
        bin_len, bin_type = struct.unpack_from("<II", data, offset)
        assert bin_type == 0x004E4942 and bin_len % 4 == 0
        binary = data[offset + 8:offset + 8 + bin_len]
    return gltf, binary


def _write_glb(path: Path, gltf: dict, binary: bytes | None) -> None:
    json_bytes = json.dumps(gltf).encode()
    json_bytes += b" " * (-len(json_bytes) % 4)
    chunks = struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
    if binary is not None:
        binary += b"\0" * (-len(binary) % 4)
        chunks += struct.pack("<II", len(binary), 0x004E4942) + binary
    header = struct.pack("<III", 0x46546C67, 2, 12 + len(chunks))
    path.write_bytes(header + chunks)


def _accessor_floats(gltf: dict, binary: bytes, index: int) -> np.ndarray:
    accessor = gltf["accessors"][index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    count = accessor["count"]
    stride = view.get("byteStride", 12)
    raw = np.frombuffer(binary, dtype=np.uint8, count=stride * (count - 1) + 12, offset=start)
    rows = np.lib.stride_tricks.as_strided(raw, shape=(count, 12), strides=(stride, 1))
    return np.frombuffer(rows.copy().tobytes(), dtype="<f4").reshape(count, 3)


def _b64(array: np.ndarray) -> str:
    return base64.b64encode(np.asarray(array, dtype="<f4").tobytes()).decode()


def _textured_two_mesh_scene(path: Path) -> None:
    textured = trimesh.creation.box()
    uv = np.random.default_rng(0).random((len(textured.vertices), 2))
    image = Image.new("RGB", (8, 8), (200, 30, 30))
    textured.visual = trimesh.visual.TextureVisuals(uv=uv, image=image)
    plain = trimesh.creation.icosphere(subdivisions=1)
    scene = trimesh.Scene()
    scene.add_geometry(textured, geom_name="textured")
    scene.add_geometry(plain, geom_name="plain")
    scene.export(str(path))


def _mesh_index(gltf: dict, name: str) -> int:
    return next(i for i, m in enumerate(gltf["meshes"]) if m.get("name") == name)


def _shared_accessor_glb(path: Path) -> None:
    """Two meshes whose single primitives share one POSITION accessor."""
    positions = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0]], dtype="<f4")
    binary = positions.tobytes()
    gltf = {
        "asset": {"version": "2.0"},
        "buffers": [{"byteLength": len(binary)}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(binary)}],
        "accessors": [{
            "bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3",
            "min": [0, 0, 0], "max": [1, 1, 0],
        }],
        "meshes": [
            {"primitives": [{"attributes": {"POSITION": 0}}]},
            {"primitives": [{"attributes": {"POSITION": 0}}]},
        ],
        "nodes": [{"mesh": 0}, {"mesh": 1}],
        "scenes": [{"nodes": [0, 1]}],
        "scene": 0,
    }
    _write_glb(path, gltf, binary)


class PatchVerticesRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.workspace = Path(self._dir.name)
        self.collection = self.workspace / "Default"
        self.collection.mkdir()
        patcher = patch.object(optimize.registry, "WORKSPACE_DIR", self.workspace)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self._dir.cleanup)

    def _patch(self, path: str, patches: list[dict]):
        return optimize.patch_vertices(optimize.PatchVerticesRequest(path=path, patches=patches))

    def _assert_400(self, path: str, patches: list[dict], fragment: str) -> None:
        with self.assertRaises(HTTPException) as caught:
            self._patch(path, patches)
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn(fragment, str(caught.exception.detail))

    # -- success ------------------------------------------------------------

    def test_patches_positions_and_normals_keeping_texture_and_other_mesh(self) -> None:
        source = self.collection / "model.glb"
        _textured_two_mesh_scene(source)
        gltf, binary = _read_glb(source)
        textured = _mesh_index(gltf, "textured")
        plain = _mesh_index(gltf, "plain")
        primitive = gltf["meshes"][textured]["primitives"][0]
        old_positions = _accessor_floats(gltf, binary, primitive["attributes"]["POSITION"])
        plain_prim = gltf["meshes"][plain]["primitives"][0]
        plain_positions = _accessor_floats(gltf, binary, plain_prim["attributes"]["POSITION"])

        new_positions = old_positions * 2.0 + np.array([0.5, -1.0, 3.0], dtype="<f4")
        new_normals = np.tile(np.array([0, 1, 0], dtype="<f4"), (len(old_positions), 1))

        response = self._patch("Default/model.glb", [{
            "mesh": textured, "primitive": 0,
            "positions": _b64(new_positions), "normals": _b64(new_normals),
        }])

        self.assertRegex(response["path"], r"^Default/model_sculpt_[0-9a-f]{8}\.glb$")
        self.assertEqual(response["url"], f"/workspace/{response['path']}")
        output = self.workspace / response["path"]
        self.assertTrue(output.is_file())
        # The input is never modified.
        self.assertEqual(_read_glb(source)[0], gltf)

        out_gltf, out_bin = _read_glb(output)
        self.assertEqual(out_gltf["buffers"][0]["byteLength"], len(out_bin))
        out_prim = out_gltf["meshes"][textured]["primitives"][0]
        pos_index = out_prim["attributes"]["POSITION"]
        nrm_index = out_prim["attributes"]["NORMAL"]
        np.testing.assert_array_equal(_accessor_floats(out_gltf, out_bin, pos_index), new_positions)
        np.testing.assert_array_equal(_accessor_floats(out_gltf, out_bin, nrm_index), new_normals)
        accessor = out_gltf["accessors"][pos_index]
        self.assertEqual(accessor["min"], new_positions.min(axis=0).tolist())
        self.assertEqual(accessor["max"], new_positions.max(axis=0).tolist())
        # Old accessors untouched, new ones appended.
        self.assertEqual(out_gltf["accessors"][: len(gltf["accessors"])], gltf["accessors"])
        self.assertEqual(out_prim["material"], primitive["material"])
        self.assertEqual(out_prim["attributes"]["TEXCOORD_0"], primitive["attributes"]["TEXCOORD_0"])
        self.assertEqual(out_gltf["images"], gltf["images"])
        self.assertEqual(out_gltf["materials"], gltf["materials"])
        out_plain = out_gltf["meshes"][plain]["primitives"][0]
        self.assertEqual(out_plain, plain_prim)
        np.testing.assert_array_equal(
            _accessor_floats(out_gltf, out_bin, out_plain["attributes"]["POSITION"]), plain_positions,
        )

        # trimesh still reads it, with the texture and the new geometry.
        scene = trimesh.load(str(output), process=False)
        mesh = scene.geometry["textured"]
        np.testing.assert_allclose(mesh.vertices, new_positions, rtol=0, atol=0)
        self.assertIsInstance(mesh.visual, trimesh.visual.TextureVisuals)
        self.assertIsNotNone(mesh.visual.material.baseColorTexture)
        np.testing.assert_allclose(scene.geometry["plain"].vertices, plain_positions)

    def test_adds_normal_attribute_when_missing(self) -> None:
        source = self.collection / "shared.glb"
        _shared_accessor_glb(source)
        normals = np.tile(np.array([0, 0, 1], dtype="<f4"), (3, 1))
        response = self._patch("Default/shared.glb", [{
            "mesh": 0, "primitive": 0,
            "positions": _b64(np.zeros((3, 3))), "normals": _b64(normals),
        }])
        out_gltf, out_bin = _read_glb(self.workspace / response["path"])
        attributes = out_gltf["meshes"][0]["primitives"][0]["attributes"]
        np.testing.assert_array_equal(_accessor_floats(out_gltf, out_bin, attributes["NORMAL"]), normals)

    def test_shared_position_accessor_moves_every_primitive_using_it(self) -> None:
        # The viewer loads one accessor as one BufferAttribute, so a stroke on
        # either primitive moves both; the file must agree or the mesh tears.
        source = self.collection / "shared.glb"
        _shared_accessor_glb(source)
        moved = np.array([[5, 5, 5], [6, 5, 5], [5, 6, 5]], dtype="<f4")
        response = self._patch("Default/shared.glb", [{
            "mesh": 1, "primitive": 0, "positions": _b64(moved),
        }])
        out_gltf, out_bin = _read_glb(self.workspace / response["path"])
        first = out_gltf["meshes"][0]["primitives"][0]["attributes"]
        second = out_gltf["meshes"][1]["primitives"][0]["attributes"]
        self.assertNotEqual(second["POSITION"], 0)
        self.assertEqual(first, second)
        np.testing.assert_array_equal(_accessor_floats(out_gltf, out_bin, second["POSITION"]), moved)

    def test_primitive_sharing_positions_but_not_normals_keeps_its_normals(self) -> None:
        source = self.collection / "shared.glb"
        _shared_accessor_glb(source)
        gltf, binary = _read_glb(source)
        gltf["meshes"][0]["primitives"][0]["attributes"]["NORMAL"] = 0  # its own (dummy) normals
        _write_glb(source, gltf, binary)
        moved = np.array([[5, 5, 5], [6, 5, 5], [5, 6, 5]], dtype="<f4")
        normals = np.array([[0, 0, 1]] * 3, dtype="<f4")
        response = self._patch("Default/shared.glb", [{
            "mesh": 1, "primitive": 0, "positions": _b64(moved), "normals": _b64(normals),
        }])
        out_gltf, _ = _read_glb(self.workspace / response["path"])
        first = out_gltf["meshes"][0]["primitives"][0]["attributes"]
        second = out_gltf["meshes"][1]["primitives"][0]["attributes"]
        self.assertEqual(first["POSITION"], second["POSITION"])
        self.assertEqual(first["NORMAL"], 0)
        self.assertNotEqual(second["NORMAL"], 0)

    def test_new_buffer_views_are_four_byte_aligned(self) -> None:
        source = self.collection / "odd.glb"
        _shared_accessor_glb(source)
        gltf, binary = _read_glb(source)
        # Make the declared buffer length not a multiple of 4 (padding follows).
        binary += b"\x01\x02"
        gltf["buffers"][0]["byteLength"] = len(binary)
        _write_glb(source, gltf, binary)
        response = self._patch("Default/odd.glb", [{
            "mesh": 0, "primitive": 0, "positions": _b64(np.ones((3, 3))),
        }])
        out_gltf, _ = _read_glb(self.workspace / response["path"])
        for view in out_gltf["bufferViews"][1:]:
            self.assertEqual(view["byteOffset"] % 4, 0)

    # -- errors -------------------------------------------------------------

    def test_rejects_non_glb_input(self) -> None:
        (self.collection / "mesh.obj").write_text("v 0 0 0\n")
        self._assert_400("Default/mesh.obj", [{
            "mesh": 0, "primitive": 0, "positions": _b64(np.zeros((1, 3))),
        }], ".glb")

    def test_rejects_empty_patch_list(self) -> None:
        _shared_accessor_glb(self.collection / "shared.glb")
        self._assert_400("Default/shared.glb", [], "patch")

    def test_rejects_count_mismatch(self) -> None:
        _shared_accessor_glb(self.collection / "shared.glb")
        self._assert_400("Default/shared.glb", [{
            "mesh": 0, "primitive": 0, "positions": _b64(np.zeros((4, 3))),
        }], "expected 9")
        self._assert_400("Default/shared.glb", [{
            "mesh": 0, "primitive": 0, "positions": _b64(np.zeros((3, 3))),
            "normals": _b64(np.zeros((2, 3))),
        }], "normals")

    def test_rejects_bad_indices(self) -> None:
        _shared_accessor_glb(self.collection / "shared.glb")
        self._assert_400("Default/shared.glb", [{
            "mesh": 7, "primitive": 0, "positions": _b64(np.zeros((3, 3))),
        }], "mesh 7")
        self._assert_400("Default/shared.glb", [{
            "mesh": 0, "primitive": 3, "positions": _b64(np.zeros((3, 3))),
        }], "primitive 3")
        self._assert_400("Default/shared.glb", [{
            "mesh": -1, "primitive": 0, "positions": _b64(np.zeros((3, 3))),
        }], "mesh -1")

    def test_rejects_bad_base64(self) -> None:
        _shared_accessor_glb(self.collection / "shared.glb")
        self._assert_400("Default/shared.glb", [{
            "mesh": 0, "primitive": 0, "positions": "not base64!!",
        }], "base64")

    def test_rejects_non_finite_values(self) -> None:
        _shared_accessor_glb(self.collection / "shared.glb")
        values = np.zeros((3, 3), dtype="<f4")
        values[1, 2] = np.nan
        self._assert_400("Default/shared.glb", [{
            "mesh": 0, "primitive": 0, "positions": _b64(values),
        }], "finite")
        values[1, 2] = np.inf
        self._assert_400("Default/shared.glb", [{
            "mesh": 0, "primitive": 0, "positions": _b64(np.zeros((3, 3))), "normals": _b64(values),
        }], "finite")

    def test_rejects_draco_compressed_primitive(self) -> None:
        source = self.collection / "draco.glb"
        _shared_accessor_glb(source)
        gltf, binary = _read_glb(source)
        gltf["meshes"][0]["primitives"][0]["extensions"] = {
            "KHR_draco_mesh_compression": {"bufferView": 0, "attributes": {"POSITION": 0}},
        }
        gltf["extensionsUsed"] = ["KHR_draco_mesh_compression"]
        _write_glb(source, gltf, binary)
        self._assert_400("Default/draco.glb", [{
            "mesh": 0, "primitive": 0, "positions": _b64(np.zeros((3, 3))),
        }], "Draco")

    def test_rejects_corrupt_glb(self) -> None:
        (self.collection / "broken.glb").write_bytes(b"glTF garbage")
        self._assert_400("Default/broken.glb", [{
            "mesh": 0, "primitive": 0, "positions": _b64(np.zeros((3, 3))),
        }], "GLB")


if __name__ == "__main__":
    unittest.main()
