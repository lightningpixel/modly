import asyncio
import tempfile
import threading
import time
import unittest
from pathlib import Path

from fastapi import BackgroundTasks

import routers.generation as generation
import routers.workflow_runs as workflow_runs
import services.generator_registry as registry_module
from schemas.generation import JobStatus


class _FakeUpload:
    """Minimal UploadFile stand-in: an image content-type and readable bytes."""

    def __init__(self, content_type: str = "image/png", data: bytes = b"\x89PNG\r\n") -> None:
        self.content_type = content_type
        self._data = data

    async def read(self) -> bytes:
        return self._data


class _FakeRegistry:
    """Accepts any model id and exposes the attrs cancel_run pokes at."""

    _generators: dict = {}
    _active_id = None

    def get_generator(self, model_id: str) -> object:
        return object()

    def get_manifest(self, model_id: str) -> dict:
        return {"output": "mesh"}

    def switch_model(self, model_id: str) -> None:
        pass


def _clear_job_stores() -> None:
    for store in (
        generation._jobs,
        generation._cancel_events,
        generation._cancelled,
        generation._completed_at,
        generation._job_generators,
    ):
        store.clear()


class WorkflowRunJobLifecycleTests(unittest.TestCase):
    """The headless /workflow-runs surface shares the job dicts with /generate,
    so it must take part in the same TTL purge — otherwise long-running
    automation leaks a JobStatus + Event per run forever."""

    def setUp(self) -> None:
        self._prev = workflow_runs.generator_registry
        workflow_runs.generator_registry = _FakeRegistry()
        _clear_job_stores()

    def tearDown(self) -> None:
        workflow_runs.generator_registry = self._prev
        _clear_job_stores()

    def test_create_run_purges_terminal_jobs_past_ttl(self) -> None:
        stale = "stale-run"
        generation._jobs[stale] = JobStatus(job_id=stale, status="done", progress=100)
        generation._cancel_events[stale] = threading.Event()
        generation._completed_at[stale] = time.monotonic() - generation._JOB_TTL - 1

        background = BackgroundTasks()
        asyncio.run(
            workflow_runs.create_run_from_image(
                background,
                image=_FakeUpload(),
                model_id="sf3d",
                collection="Default",
                params="{}",
            )
        )

        # Before the fix create_run_from_image never purged, so the stale job lingered.
        self.assertNotIn(stale, generation._jobs)
        self.assertNotIn(stale, generation._completed_at)
        self.assertNotIn(stale, generation._cancel_events)

    def test_cancel_run_records_completion_so_it_can_be_purged(self) -> None:
        run_id = "run-1"
        generation._jobs[run_id] = JobStatus(job_id=run_id, status="running", progress=10)
        generation._cancel_events[run_id] = threading.Event()

        asyncio.run(workflow_runs.cancel_run(run_id))

        self.assertEqual(generation._jobs[run_id].status, "cancelled")
        # Without a _completed_at stamp the purge sweep can never evict a cancelled run.
        self.assertIn(run_id, generation._completed_at)

    def test_workflow_and_generate_routes_share_exact_model_queue_and_cancellation(self) -> None:
        class Proc:
            def __init__(self, owner):
                self.owner = owner
                self.alive = True
            def poll(self): return None if self.alive else 0
            def kill(self):
                self.alive = False
                self.owner.killed = True

        class Generator:
            def __init__(self, model_id):
                self.model_id = model_id
                self.outputs_dir = None
                self.loaded = False
                self.started = threading.Event()
                self.killed = False
                self._loaded = True
                self._proc = Proc(self)
            def is_loaded(self): return self.loaded
            def load(self): self.loaded = True
            def unload(self): self.loaded = False
            def generate(self, image_bytes, params, progress_cb, cancel_event=None):
                self.started.set()
                if self.model_id == "demo/workflow":
                    if cancel_event is None or not cancel_event.wait(2):
                        raise AssertionError("workflow job was not cancelled")
                    raise generation.GenerationCancelled()
                output = Path(self.outputs_dir) / "result.glb"
                output.write_bytes(b"glb")
                return output

        class Registry:
            def __init__(self):
                ids = ("demo/workflow", "demo/generate")
                self.generators = {model_id: Generator(model_id) for model_id in ids}
                self.active_id = "demo/generate"
            def assert_weight_variant_installed(self, params, model_id=None): pass
            def get_generator(self, model_id): return self.generators[model_id]
            def get_manifest(self, model_id): return {"output": "mesh"}
            def model_status(self, model_id):
                gen = self.generators[model_id]
                return {"name": model_id, "downloaded": True, "loaded": gen.loaded}
            def activate_ready_generator(self, model_id):
                if model_id != self.active_id:
                    self.generators[self.active_id].unload()
                    self.active_id = model_id
                gen = self.generators[model_id]
                gen.load()
                if sum(candidate.loaded for candidate in self.generators.values()) != 1:
                    raise AssertionError("more than one generator is resident")
                return gen
            def get_active(self): raise AssertionError("queued routes must use their pinned model id")

        fake_registry = Registry()
        previous_generation_registry = generation.generator_registry
        previous_workflow_registry = workflow_runs.generator_registry
        previous_workspace = registry_module.WORKSPACE_DIR
        with tempfile.TemporaryDirectory() as tmp:
            registry_module.WORKSPACE_DIR = Path(tmp)
            generation.generator_registry = fake_registry
            workflow_runs.generator_registry = fake_registry

            async def run_cross_route_jobs():
                workflow_background = BackgroundTasks()
                workflow_response = await workflow_runs.create_run_from_image(
                    workflow_background, _FakeUpload(), "demo/workflow", "Workflows", "{}",
                )
                generate_background = BackgroundTasks()
                generate_response = await generation.generate_from_image(
                    generate_background, _FakeUpload(), "demo/generate", "Workflows",
                    "quad", False, 1024, "{}",
                )
                self.assertEqual(workflow_background.tasks[0].args[5], "demo/workflow")
                self.assertEqual(generate_background.tasks[0].args[5], "demo/generate")

                first = asyncio.create_task(workflow_background.tasks[0]())
                second = asyncio.create_task(generate_background.tasks[0]())
                started = await asyncio.to_thread(
                    fake_registry.generators["demo/workflow"].started.wait, 1,
                )
                self.assertTrue(started)
                await asyncio.sleep(0.05)
                self.assertFalse(fake_registry.generators["demo/generate"].started.is_set())
                await workflow_runs.cancel_run(workflow_response["run_id"])
                await asyncio.gather(first, second)
                return workflow_response["run_id"], generate_response["job_id"]

            try:
                workflow_job_id, generate_job_id = asyncio.run(run_cross_route_jobs())
            finally:
                generation.generator_registry = previous_generation_registry
                workflow_runs.generator_registry = previous_workflow_registry
                registry_module.WORKSPACE_DIR = previous_workspace

        self.assertTrue(fake_registry.generators["demo/workflow"].killed)
        self.assertFalse(fake_registry.generators["demo/generate"].killed)
        self.assertEqual(generation._jobs[workflow_job_id].status, "cancelled")
        self.assertEqual(generation._jobs[generate_job_id].status, "done")
        self.assertEqual(fake_registry.active_id, "demo/generate")


class _FakeProc:
    """Stands in for a loaded extension worker's subprocess."""

    def __init__(self) -> None:
        self.killed = False

    def poll(self):
        return -9 if self.killed else None

    def kill(self) -> None:
        self.killed = True


class _FakeWorker:
    """A loaded generator with a live subprocess, as _run_generation binds it."""

    def __init__(self) -> None:
        self._proc = _FakeProc()
        self._loaded = True
        self.outputs_dir = None

    def generate(self, image_bytes, params, progress_cb, cancel_event=None):
        output = Path(self.outputs_dir) / "result.glb"
        output.write_bytes(b"glb")
        return output


class _FailingWorker(_FakeWorker):
    def generate(self, image_bytes, params, progress_cb, cancel_event=None):
        raise RuntimeError("inference failed")


class _RegistryWithLoadedWorker:
    """Keeps one worker loaded and active, the state the worker is left in
    after a job ends normally."""

    def __init__(self, worker: _FakeWorker) -> None:
        self.worker = worker
        self._generators = {"ext/model": worker}
        self._active_id = "ext/model"

    def assert_weight_variant_installed(self, params, model_id) -> None:
        pass

    def get_generator(self, model_id: str):
        return self.worker

    def model_status(self, model_id: str) -> dict:
        return {"name": model_id, "downloaded": True, "loaded": True}

    def activate_ready_generator(self, model_id: str):
        return self.worker


class CancelEndedJobTests(unittest.TestCase):
    """cancel_job kills the subprocess bound to the job in _job_generators so
    inference stops at once. Once the job has ended, that binding is gone and
    the worker holds the warm model (or another job's generation), so a late
    cancel of the ended job/run must leave the worker alone."""

    def setUp(self) -> None:
        self._prev_generation_registry = generation.generator_registry
        self._prev_runs_registry = workflow_runs.generator_registry
        self._prev_workspace = registry_module.WORKSPACE_DIR
        self._tmp = tempfile.TemporaryDirectory()
        registry_module.WORKSPACE_DIR = Path(self._tmp.name)
        _clear_job_stores()

    def tearDown(self) -> None:
        generation.generator_registry = self._prev_generation_registry
        workflow_runs.generator_registry = self._prev_runs_registry
        registry_module.WORKSPACE_DIR = self._prev_workspace
        self._tmp.cleanup()
        _clear_job_stores()

    def _use_worker(self, worker: _FakeWorker) -> _FakeWorker:
        registry = _RegistryWithLoadedWorker(worker)
        generation.generator_registry = registry
        workflow_runs.generator_registry = registry
        return worker

    def _file_job(self, job_id: str, status: str = "pending") -> None:
        generation._jobs[job_id] = JobStatus(job_id=job_id, status=status, progress=0)
        generation._cancel_events[job_id] = threading.Event()

    def _run_to_end(self, job_id: str) -> None:
        self._file_job(job_id)
        asyncio.run(generation._run_generation(job_id, b"img", {}, "Default", "mesh", "ext/model"))
        # The job's generator binding is released as soon as it ends.
        self.assertNotIn(job_id, generation._job_generators)

    def _assert_worker_untouched(self, worker: _FakeWorker, proc: _FakeProc) -> None:
        self.assertFalse(proc.killed)
        self.assertIs(worker._proc, proc)
        self.assertTrue(worker._loaded)

    def _assert_worker_stopped(self, worker: _FakeWorker, proc: _FakeProc) -> None:
        self.assertTrue(proc.killed)
        self.assertIsNone(worker._proc)
        self.assertFalse(worker._loaded)

    def test_cancelling_a_finished_job_leaves_the_active_worker_alone(self) -> None:
        worker = self._use_worker(_FakeWorker())
        proc = worker._proc
        self._run_to_end("finished-job")
        self.assertEqual(generation._jobs["finished-job"].status, "done")

        asyncio.run(generation.cancel_job("finished-job"))

        self.assertEqual(generation._jobs["finished-job"].status, "done")
        self._assert_worker_untouched(worker, proc)

    def test_cancelling_a_failed_run_leaves_the_active_worker_alone(self) -> None:
        worker = self._use_worker(_FailingWorker())
        proc = worker._proc
        self._run_to_end("failed-run")
        self.assertEqual(generation._jobs["failed-run"].status, "error")

        asyncio.run(workflow_runs.cancel_run("failed-run"))

        self.assertEqual(generation._jobs["failed-run"].status, "error")
        self._assert_worker_untouched(worker, proc)

    def test_cancelling_an_ended_job_leaves_another_jobs_worker_alone(self) -> None:
        worker = self._use_worker(_FakeWorker())
        proc = worker._proc
        self._run_to_end("finished-job")
        # A later job now owns the same worker.
        self._file_job("running-job", "running")
        generation._job_generators["running-job"] = worker

        asyncio.run(generation.cancel_job("finished-job"))

        self.assertEqual(generation._jobs["running-job"].status, "running")
        self._assert_worker_untouched(worker, proc)

    def test_cancelling_a_running_job_still_stops_the_worker(self) -> None:
        worker = self._use_worker(_FakeWorker())
        proc = worker._proc
        self._file_job("running-job", "running")
        generation._job_generators["running-job"] = worker

        asyncio.run(generation.cancel_job("running-job"))

        self.assertEqual(generation._jobs["running-job"].status, "cancelled")
        self._assert_worker_stopped(worker, proc)

    def test_cancelling_a_running_run_still_stops_the_worker(self) -> None:
        worker = self._use_worker(_FakeWorker())
        proc = worker._proc
        self._file_job("running-run", "running")
        generation._job_generators["running-run"] = worker

        asyncio.run(workflow_runs.cancel_run("running-run"))

        self.assertEqual(generation._jobs["running-run"].status, "cancelled")
        self._assert_worker_stopped(worker, proc)


if __name__ == "__main__":
    unittest.main()
