import asyncio
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from fastapi import HTTPException
from PIL import Image

import routers.image as image_router
import services.generator_registry as registry
from services.image_ops import ImageOpExecutionError, ImageOpResult, ImageOpsRegistry
from test_image_ops_registry import FakeRequirement, make_op


async def _collect(response) -> list[dict]:
    frames = []
    async for chunk in response.body_iterator:
        text = chunk.decode() if isinstance(chunk, bytes) else chunk
        for part in text.split("\n\n"):
            if part.startswith("data: "):
                frames.append(json.loads(part[6:]))
    return frames


class ImageRouterTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmp.name) / "workspace"
        self.workspace.mkdir()
        self.runtime = FakeRequirement("runtime", False, size=100)
        self.model = FakeRequirement("model", False, size=300)
        self.calls = []

        def fn(path, params, ctx):
            self.calls.append((path, params, ctx))
            out = ctx.images_dir / "out-nobg.png"
            mask = ctx.images_dir / "out-mask.png"
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(b"png")
            mask.write_bytes(b"png")
            return ImageOpResult(path=out, mask_path=mask)

        op = make_op([self.runtime, self.model], fn=fn)
        self.registry = ImageOpsRegistry([op])
        self._patches = [
            patch.object(registry, "WORKSPACE_DIR", self.workspace),
            patch.object(image_router, "image_ops_registry", self.registry),
            patch.dict(image_router._prepares, clear=True),
        ]
        for p in self._patches:
            p.start()
        self.image = self.workspace / "photo.jpg"
        Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8)).save(self.image)

    def tearDown(self) -> None:
        for p in reversed(self._patches):
            p.stop()
        self._tmp.cleanup()

    def _run(self, path: str, params=None):
        return asyncio.run(image_router.run_image_operation("example", image_router.ImageOpRequest(path=path, params=params or {})))

    def test_ops_lists_the_registry(self) -> None:
        body = image_router.list_image_operations()
        self.assertEqual([op["id"] for op in body["ops"]], ["example"])
        self.assertEqual([r["kind"] for r in body["ops"][0]["requirements"]], ["runtime", "model"])

    def test_builtin_op_is_exposed(self) -> None:
        from services.image_ops import image_ops_registry
        self.assertIn("remove_background", [op["id"] for op in image_ops_registry.describe()])

    def test_status_reports_missing_and_bytes(self) -> None:
        self.assertEqual(
            image_router.image_operation_status("example"),
            {"ready": False, "missing": ["runtime", "model"], "download_bytes": 400, "preparing": False},
        )
        self.runtime.ready = True
        self.assertEqual(image_router.image_operation_status("example")["download_bytes"], 300)
        self.model.ready = True
        self.assertEqual(
            image_router.image_operation_status("example"),
            {"ready": True, "missing": [], "download_bytes": None, "preparing": False},
        )

    def test_unknown_op_is_404(self) -> None:
        for call in (
            lambda: image_router.image_operation_status("nope"),
            lambda: asyncio.run(image_router.run_image_operation("nope", image_router.ImageOpRequest(path=str(self.image)))),
            lambda: asyncio.run(image_router.prepare_image_operation("nope")),
        ):
            with self.assertRaises(HTTPException) as caught:
                call()
            self.assertEqual(caught.exception.status_code, 404)

    def test_run_when_not_ready_is_409_with_missing(self) -> None:
        self.runtime.ready = True
        with self.assertRaises(HTTPException) as caught:
            self._run(str(self.image))
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(caught.exception.detail, {"code": "not_ready", "missing": ["model"]})
        self.assertEqual(self.calls, [])

    def test_run_rejects_non_images_and_missing_files(self) -> None:
        self.runtime.ready = self.model.ready = True
        other = self.workspace / "model.glb"
        other.write_bytes(b"glb")
        cases = [(str(other), 400), ("", 400), (str(self.workspace / "gone.png"), 404)]
        for path, status in cases:
            with self.subTest(path=path), self.assertRaises(HTTPException) as caught:
                self._run(path)
            self.assertEqual(caught.exception.status_code, status)
        self.assertEqual(self.calls, [])

    def test_run_refuses_images_outside_the_workspace(self) -> None:
        self.runtime.ready = self.model.ready = True
        outside = Path(self._tmp.name) / "outside.png"
        Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8)).save(outside)
        sibling = Path(f"{self.workspace}-other") / "photo.png"
        sibling.parent.mkdir()
        Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8)).save(sibling)
        for path in (
            str(outside),
            "../outside.png",
            str(self.workspace / "Images" / ".." / ".." / "outside.png"),
            str(sibling),
        ):
            with self.subTest(path=path), self.assertRaises(HTTPException) as caught:
                self._run(path)
            self.assertEqual(caught.exception.status_code, 403)
            self.assertEqual(caught.exception.detail["code"], "outside_workspace")
        self.assertEqual(self.calls, [])

    def test_run_refuses_a_symlink_out_of_the_workspace(self) -> None:
        self.runtime.ready = self.model.ready = True
        outside = Path(self._tmp.name) / "outside.png"
        Image.fromarray(np.zeros((4, 4, 3), dtype=np.uint8)).save(outside)
        link = self.workspace / "link.png"
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest("creating symlinks is not permitted here")
        with self.assertRaises(HTTPException) as caught:
            self._run(str(link))
        self.assertEqual(caught.exception.status_code, 403)
        self.assertEqual(self.calls, [])

    def test_run_accepts_absolute_and_workspace_relative_paths(self) -> None:
        self.runtime.ready = self.model.ready = True
        for path in (str(self.image), "photo.jpg"):
            with self.subTest(path=path):
                body = self._run(path, {"strength": 0.5})
                self.assertEqual(Path(body["path"]), (self.workspace / "Images" / "out-nobg.png").resolve())
                self.assertEqual(Path(body["mask_path"]), (self.workspace / "Images" / "out-mask.png").resolve())
                self.assertEqual(body["url"], "/workspace/Images/out-nobg.png")
        path, params, ctx = self.calls[-1]
        self.assertEqual(path, self.image.resolve())
        self.assertEqual(params["strength"], 0.5)
        self.assertEqual(ctx.workspace_dir, self.workspace)

    def test_run_maps_bad_params_and_failures(self) -> None:
        self.runtime.ready = self.model.ready = True
        with self.assertRaises(HTTPException) as caught:
            self._run(str(self.image), {"strength": "x"})
        self.assertEqual(caught.exception.status_code, 400)

        def boom(*_):
            raise ImageOpExecutionError("inference failed")

        self.registry._operations["example"] = make_op([self.runtime, self.model], fn=boom)
        with self.assertRaises(HTTPException) as caught:
            self._run(str(self.image))
        self.assertEqual(caught.exception.status_code, 500)

    def test_run_happens_off_the_event_loop(self) -> None:
        self.runtime.ready = self.model.ready = True
        threads = []
        self.registry._operations["example"] = make_op(
            [self.runtime, self.model],
            fn=lambda p, params, ctx: threads.append(threading.current_thread()) or ImageOpResult(path=p),
        )
        self._run(str(self.image))
        self.assertIsNot(threads[0], threading.main_thread())

    def test_prepare_when_ready_is_a_single_done_frame(self) -> None:
        self.runtime.ready = self.model.ready = True

        async def go():
            return await _collect(await image_router.prepare_image_operation("example"))

        self.assertEqual(asyncio.run(go()), [{"percent": 100, "status": "done"}])
        self.assertEqual(self.runtime.installs + self.model.installs, 0)

    def test_prepare_installs_runtime_then_model_with_weighted_progress(self) -> None:
        order = []
        for req in (self.runtime, self.model):
            original = req.install
            req.install = lambda progress, _o=original, _r=req: (order.append(_r.kind), _o(progress))

        async def go():
            return await _collect(await image_router.prepare_image_operation("example"))

        frames = asyncio.run(go())
        self.assertEqual(order, ["runtime", "model"])
        self.assertEqual(frames[-1], {"percent": 100, "status": "done"})
        percents = [f["percent"] for f in frames]
        self.assertEqual(percents, sorted(percents))
        # runtime is 100 of 400 bytes: its half-way frame is 12-13 %.
        half_runtime = next(f for f in frames if f.get("step") == "runtime" and f["status"] == "half")
        self.assertEqual(half_runtime["percent"], 12)
        half_model = next(f for f in frames if f.get("step") == "model" and f["status"] == "half")
        self.assertEqual(half_model["percent"], 62)
        self.assertEqual(self.registry.get("example").missing(), [])

    def test_prepare_skips_requirements_already_installed(self) -> None:
        self.runtime.ready = True

        async def go():
            return await _collect(await image_router.prepare_image_operation("example"))

        asyncio.run(go())
        self.assertEqual((self.runtime.installs, self.model.installs), (0, 1))

    def test_prepare_failure_is_an_error_frame(self) -> None:
        def fail(progress):
            raise ImageOpExecutionError("Installing ONNX Runtime failed (pip exited with code 1).")

        self.runtime.install = fail

        async def go():
            return await _collect(await image_router.prepare_image_operation("example"))

        frames = asyncio.run(go())
        self.assertEqual(frames[-1], {"error": "Installing ONNX Runtime failed (pip exited with code 1)."})
        self.assertEqual(self.model.installs, 0)

    def test_a_second_prepare_joins_the_running_one(self) -> None:
        gate = threading.Event()
        original = self.model.install

        def slow_install(progress):
            gate.wait(5)
            original(progress)

        self.model.install = slow_install

        async def go():
            first = await image_router.prepare_image_operation("example")
            first_frames = asyncio.ensure_future(_collect(first))
            await asyncio.sleep(0.05)
            self.assertTrue(image_router.image_operation_status("example")["preparing"])
            second = await image_router.prepare_image_operation("example")
            second_frames = asyncio.ensure_future(_collect(second))
            await asyncio.sleep(0.05)
            gate.set()
            return await first_frames, await second_frames

        first, second = asyncio.run(go())
        self.assertEqual(first[-1]["status"], "done")
        self.assertEqual(second[-1]["status"], "done")
        self.assertEqual((self.runtime.installs, self.model.installs), (1, 1))


if __name__ == "__main__":
    unittest.main()
