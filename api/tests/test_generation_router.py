import asyncio
import tempfile
import threading
import unittest
from pathlib import Path

from fastapi import BackgroundTasks

import services.generator_registry as registry
import routers.generation as generation
from schemas.generation import JobStatus


class _FakeGenerator:
    """Writes its output into whatever directory generation assigns it."""

    def __init__(self) -> None:
        self.outputs_dir: Path | None = None

    def generate(self, image_bytes, params, progress_cb, cancel_event=None) -> Path:
        out = Path(self.outputs_dir) / "model.glb"
        out.write_bytes(b"glb")
        return out


class _FakeUpload:
    """Minimal UploadFile stand-in: an image content-type and readable bytes."""

    def __init__(self, content_type: str = "image/png", data: bytes = b"\x89PNG\r\n") -> None:
        self.content_type = content_type
        self._data = data

    async def read(self) -> bytes:
        return self._data


class _FakeRegistry:
    def __init__(self, gen: _FakeGenerator) -> None:
        self._gen = gen

    def active_status(self) -> dict:
        # Report loaded so _run_generation skips the download/load thread.
        return {"loaded": True, "name": "fake", "downloaded": True}

    def get_active(self) -> _FakeGenerator:
        return self._gen

    # generate_from_image looks the model up and switches to it before filing the job.
    def get_generator(self, model_id: str) -> _FakeGenerator:
        return self._gen

    def switch_model(self, model_id: str) -> None:
        pass


class RunGenerationWorkspaceTests(unittest.TestCase):
    """A generation started after the workspace path is relocated at runtime
    (POST /settings/paths) must file its output under the *current* workspace,
    not the one captured when the module was imported."""

    def setUp(self) -> None:
        self._prev_registry = generation.generator_registry
        self._prev_ws = registry.WORKSPACE_DIR
        self._tmp = tempfile.TemporaryDirectory()
        # The user relocated the workspace: the registry global now points here.
        registry.WORKSPACE_DIR = Path(self._tmp.name) / "new_workspace"
        # Keep the test hermetic against the module's import-time binding: if the
        # stale name still exists (before the fix) redirect it into the temp tree
        # so the assertion — not a stray write to the real workspace — is what
        # catches the bug.
        self._had_stale = hasattr(generation, "WORKSPACE_DIR")
        if self._had_stale:
            generation.WORKSPACE_DIR = Path(self._tmp.name) / "old_workspace"

    def tearDown(self) -> None:
        generation.generator_registry = self._prev_registry
        registry.WORKSPACE_DIR = self._prev_ws
        if self._had_stale:
            generation.WORKSPACE_DIR = self._prev_ws
        for store in (
            generation._jobs,
            generation._cancel_events,
            generation._cancelled,
            generation._completed_at,
        ):
            store.clear()
        self._tmp.cleanup()

    def _run(self, collection: str) -> tuple[_FakeGenerator, JobStatus]:
        gen = _FakeGenerator()
        generation.generator_registry = _FakeRegistry(gen)
        job_id = "job-test"
        generation._jobs[job_id] = JobStatus(job_id=job_id, status="pending", progress=0)
        generation._cancel_events[job_id] = threading.Event()
        asyncio.run(generation._run_generation(job_id, b"img", {}, collection))
        return gen, generation._jobs[job_id]

    def test_output_lands_under_the_current_workspace(self) -> None:
        gen, job = self._run("MyColl")
        self.assertEqual(Path(gen.outputs_dir), registry.WORKSPACE_DIR / "MyColl")
        self.assertEqual(job.status, "done")
        self.assertEqual(job.output_url, "/workspace/MyColl/model.glb")


class GenerateFromImageWorkspaceTests(unittest.TestCase):
    """The request path must survive the relocation too, not just the worker:
    sanitize_collection() checks the name's containment against the workspace
    root before the job is filed, so it has to read the same live binding -- a
    stale (or missing) module-level name there fails every POST
    /generate/from-image, whatever _run_generation does afterwards."""

    def setUp(self) -> None:
        self._prev_registry = generation.generator_registry
        self._prev_ws = registry.WORKSPACE_DIR
        self._tmp = tempfile.TemporaryDirectory()
        registry.WORKSPACE_DIR = Path(self._tmp.name) / "new_workspace"
        generation.generator_registry = _FakeRegistry(_FakeGenerator())

    def tearDown(self) -> None:
        generation.generator_registry = self._prev_registry
        registry.WORKSPACE_DIR = self._prev_ws
        for store in (
            generation._jobs,
            generation._cancel_events,
            generation._cancelled,
            generation._completed_at,
        ):
            store.clear()
        self._tmp.cleanup()

    def test_request_is_filed_after_the_workspace_moves(self) -> None:
        background = BackgroundTasks()
        response = asyncio.run(
            generation.generate_from_image(
                background,
                image=_FakeUpload(),
                model_id="sf3d",
                collection="MyColl",
                remesh="quad",
                enable_texture=False,
                texture_resolution=1024,
                params="{}",
            )
        )
        self.assertIn(response["job_id"], generation._jobs)
        # add_task(_run_generation, job_id, image_bytes, full_params, collection)
        self.assertEqual(background.tasks[0].args[3], "MyColl")


if __name__ == "__main__":
    unittest.main()
