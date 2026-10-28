import importlib.util
import re
import subprocess
import sys
import unittest
from pathlib import Path


API_DIR = Path(__file__).resolve().parents[1]
HAS_PYMESHLAB = importlib.util.find_spec("pymeshlab") is not None

# Runs every mesh-op family on a holed box with networkx unimportable: it is
# not in requirements.txt, so the shipped venv never has it, while a dev venv
# often does (torch pulls it in) and would hide the gap.
_SCRIPT = r"""
import sys, tempfile
sys.modules["networkx"] = None
from pathlib import Path
import numpy as np, trimesh
from services.mesh_ops import MeshOpContext, mesh_ops_registry as registry

directory = Path(tempfile.mkdtemp())
context = MeshOpContext(directory, directory)
box = trimesh.creation.box()
box.update_faces(np.arange(1, len(box.faces)))
path = directory / "open.glb"
box.export(path)

registry.run("inspect_mesh", path, {}, context)
registry.run("suggest_fixes", path, {}, context)
repaired = registry.run("repair_mesh", path, {}, context)
assert repaired.details["after"]["is_watertight"], repaired.details

# Flipped faces take the re-orientation path.
sphere = trimesh.creation.icosphere(subdivisions=2)
faces = sphere.faces.copy()
faces[:20] = faces[:20, ::-1]
flipped = directory / "flipped.glb"
trimesh.Trimesh(sphere.vertices, faces, process=False).export(flipped)
reoriented = registry.run("repair_mesh", flipped, {}, context)
assert "reorient_faces" in reoriented.details["steps"], reoriented.details
for op in ("recenter", "drop_to_ground", "auto_orient", "normalize_scale"):
    registry.run(op, path, {}, context)
print("ok")
"""


class MeshOpDependencyTests(unittest.TestCase):
    @unittest.skipUnless(HAS_PYMESHLAB, "pymeshlab is not installed")
    def test_mesh_ops_run_without_undeclared_networkx(self) -> None:
        result = subprocess.run(
            [sys.executable, "-c", _SCRIPT],
            cwd=API_DIR,
            capture_output=True,
            text=True,
            timeout=300,
        )

        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        self.assertEqual(result.stdout.strip().splitlines()[-1], "ok")

    def test_trimesh_graph_engine_is_a_declared_dependency(self) -> None:
        # inspect_mesh and repair_mesh need scipy through trimesh, which does
        # not depend on it; a dev environment usually has it anyway.
        requirements = (API_DIR / "requirements.txt").read_text(encoding="utf-8")
        declared = {
            re.split(r"[<>=\[;\s]", line.strip(), maxsplit=1)[0].lower()
            for line in requirements.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }

        self.assertIn("scipy", declared)
        self.assertIn("trimesh", declared)
        self.assertIn("pymeshlab", declared)


if __name__ == "__main__":
    unittest.main()
