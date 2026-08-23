"""
Regression tests for the path parameters an outside caller controls.

The API listens on loopback with no authentication and answers with
Access-Control-Allow-Origin, so every one of these was reachable from any page
the user had open in a browser. Each test below was a working exploit before
the fix; the file exists so they stay dead.
"""
import importlib
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.safe_paths import UnsafePath, resolve_within, safe_segment  # noqa: E402


class SafePathUnitTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name) / "root"
        (self.root / "sub").mkdir(parents=True)
        (self.root / "sub" / "ok.txt").write_text("ok", encoding="utf-8")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_plain_relative_path_resolves(self):
        self.assertEqual(resolve_within(self.root, "sub/ok.txt"), self.root / "sub" / "ok.txt")

    def test_absolute_path_inside_the_root_is_allowed(self):
        """The splat/GLB conversion cache hands out absolute paths of its own."""
        target = self.root / "sub" / "ok.txt"
        self.assertEqual(resolve_within(self.root, str(target)), target)

    def test_parent_traversal_is_rejected(self):
        for probe in ("../outside.txt", "..\\outside.txt", "sub/../../outside.txt"):
            with self.subTest(probe=probe):
                with self.assertRaises(UnsafePath):
                    resolve_within(self.root, probe)

    def test_absolute_path_outside_the_root_is_rejected(self):
        outside = Path(self._tmp.name) / "secret.txt"
        outside.write_text("s", encoding="utf-8")
        with self.assertRaises(UnsafePath):
            resolve_within(self.root, str(outside))

    def test_sibling_directory_sharing_the_prefix_is_rejected(self):
        """`str(p).startswith(str(root))` accepted "<root>_evil/leak": a real
        parent/child relation needs the separator, which a prefix test drops."""
        sibling = Path(str(self.root) + "_evil")
        sibling.mkdir()
        (sibling / "leak.txt").write_text("leak", encoding="utf-8")
        rel = os.path.relpath(sibling / "leak.txt", self.root)
        with self.assertRaises(UnsafePath):
            resolve_within(self.root, rel)

    def test_safe_segment_accepts_a_plain_name(self):
        self.assertEqual(safe_segment("hunyuan3d-mini"), "hunyuan3d-mini")

    def test_safe_segment_rejects_separators_and_traversal(self):
        for probe in ("..", ".", "", "a/b", "a\\b", "..\\evil", "../evil", "C:", "C:evil", "a\x00b"):
            with self.subTest(probe=probe):
                with self.assertRaises(UnsafePath):
                    safe_segment(probe)


def _client():
    """TestClient over the real app. Imported lazily: pulling in `main` builds
    the whole generator registry."""
    from fastapi.testclient import TestClient
    return TestClient(importlib.import_module("main").app)


class WorkspaceServingTests(unittest.TestCase):
    """`GET /workspace/{path}` served any file on the disk: the URL router hands
    "..%2F" and "..\\" over decoded, and nothing confined the join."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.client = _client()
        import services.generator_registry as reg
        self.reg = reg
        self._orig_ws = reg.WORKSPACE_DIR
        reg.WORKSPACE_DIR = Path(self._tmp.name) / "workspace"
        (reg.WORKSPACE_DIR / "Workflows").mkdir(parents=True)
        (reg.WORKSPACE_DIR / "Workflows" / "mesh.glb").write_bytes(b"glTF-ok")
        self.secret = Path(self._tmp.name) / "SECRET.txt"
        self.secret.write_text("sk-live-DEADBEEF", encoding="utf-8")

    def tearDown(self) -> None:
        self.reg.WORKSPACE_DIR = self._orig_ws
        self._tmp.cleanup()

    def test_serves_a_file_inside_the_workspace(self):
        r = self.client.get("/workspace/Workflows/mesh.glb")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, b"glTF-ok")

    def test_traversal_out_of_the_workspace_is_refused(self):
        for probe in ("..%2FSECRET.txt", "..\\SECRET.txt", "Workflows%2F..%2F..%2FSECRET.txt"):
            with self.subTest(probe=probe):
                r = self.client.get("/workspace/" + probe)
                self.assertNotEqual(r.status_code, 200)
                self.assertNotIn(b"DEADBEEF", r.content)


class ExtensionSetupTests(unittest.TestCase):
    """`POST /extensions/setup/{ext_id}` RUNS the setup.py it finds. A backslash
    is not a separator to the URL router but is one to the filesystem, so
    "..\\anywhere" ran any setup.py on the disk: remote code execution from a
    web page, a bare cross-origin POST needing no preflight."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.client = _client()
        import services.generator_registry as reg
        self.reg = reg
        self._orig = reg.EXTENSIONS_DIR
        reg.EXTENSIONS_DIR = Path(self._tmp.name) / "extensions"
        reg.EXTENSIONS_DIR.mkdir(parents=True)
        self.outside = Path(self._tmp.name) / "evil_ext"
        self.outside.mkdir()
        self.marker = self.outside / "PWNED.txt"
        (self.outside / "setup.py").write_text(
            "import pathlib\npathlib.Path(r'" + str(self.marker) + "').write_text('rce')\n",
            encoding="utf-8")

    def tearDown(self) -> None:
        self.reg.EXTENSIONS_DIR = self._orig
        self._tmp.cleanup()

    def test_backslash_traversal_does_not_run_an_outside_setup_py(self):
        r = self.client.post("/extensions/setup/..\\evil_ext")
        self.assertEqual(r.status_code, 400)
        self.assertFalse(self.marker.exists(), "setup.py outside the extensions dir was executed")

    def test_slash_traversal_does_not_run_an_outside_setup_py(self):
        for probe in ("..%2Fevil_ext", "../evil_ext"):
            with self.subTest(probe=probe):
                r = self.client.post("/extensions/setup/" + probe)
                self.assertIn(r.status_code, (400, 404, 405))
                self.assertFalse(self.marker.exists())

    def test_a_real_extension_without_setup_py_is_still_skipped(self):
        (self.reg.EXTENSIONS_DIR / "plain").mkdir()
        r = self.client.post("/extensions/setup/plain")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["status"], "skipped")


class DownloadDestinationTests(unittest.TestCase):
    """`GET /model/hf-download?model_id=..` chose the destination directory, so
    a traversal wrote attacker-chosen files anywhere the app can write: a
    startup folder, or an extension's setup.py to pair with the endpoint above."""

    def setUp(self) -> None:
        self.client = _client()

    def test_traversal_in_the_model_id_is_refused(self):
        for probe in ("..\\..\\evil", "../../evil", "C:evil"):
            with self.subTest(probe=probe):
                r = self.client.get("/model/hf-download",
                                    params={"repo_id": "attacker/payload", "model_id": probe})
                self.assertEqual(r.status_code, 400)


class ServeFileTests(unittest.TestCase):
    """`GET /optimize/serve-file?path=` took an absolute path as-is: any .glb or
    .splat on the disk, served to whoever asked."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.client = _client()
        import services.generator_registry as reg
        self.reg = reg
        self._orig_ws = reg.WORKSPACE_DIR
        reg.WORKSPACE_DIR = Path(self._tmp.name) / "workspace"
        reg.WORKSPACE_DIR.mkdir(parents=True)
        self.inside = reg.WORKSPACE_DIR / "ok.glb"
        self.inside.write_bytes(b"glTF-inside")
        # Outside the workspace and outside any "modly_*" temp dir.
        self.outside = Path(self._tmp.name) / "private.glb"
        self.outside.write_bytes(b"glTF-private")

    def tearDown(self) -> None:
        self.reg.WORKSPACE_DIR = self._orig_ws
        self._tmp.cleanup()

    def test_a_workspace_file_is_still_served(self):
        r = self.client.get("/optimize/serve-file", params={"path": str(self.inside)})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.content, b"glTF-inside")

    def test_a_converted_file_in_the_temp_cache_is_still_served(self):
        cache = Path(tempfile.mkdtemp(prefix="modly_import_"))
        try:
            (cache / "mesh.glb").write_bytes(b"glTF-temp")
            r = self.client.get("/optimize/serve-file", params={"path": str(cache / "mesh.glb")})
            self.assertEqual(r.status_code, 200)
            self.assertEqual(r.content, b"glTF-temp")
        finally:
            shutil.rmtree(cache, ignore_errors=True)

    def test_a_file_outside_both_roots_is_refused(self):
        r = self.client.get("/optimize/serve-file", params={"path": str(self.outside)})
        self.assertEqual(r.status_code, 400)
        self.assertNotIn(b"private", r.content)

    def test_someone_elses_temp_file_is_refused(self):
        """The conversion cache lives in the temp dir, but the temp dir is not
        ours - only the "modly_*" entries in it are."""
        foreign = Path(tempfile.gettempdir()) / "other_app_secret.glb"
        foreign.write_bytes(b"glTF-foreign")
        try:
            r = self.client.get("/optimize/serve-file", params={"path": str(foreign)})
            self.assertEqual(r.status_code, 400)
            self.assertNotIn(b"foreign", r.content)
        finally:
            foreign.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
