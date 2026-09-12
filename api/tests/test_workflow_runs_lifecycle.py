import asyncio
import threading
import time
import unittest

from fastapi import BackgroundTasks

import routers.generation as generation
import routers.workflow_runs as workflow_runs
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

    def switch_model(self, model_id: str) -> None:
        pass


def _clear_job_stores() -> None:
    for store in (
        generation._jobs,
        generation._cancel_events,
        generation._cancelled,
        generation._completed_at,
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


class _FakeProc:
    """Stands in for a loaded extension worker's subprocess."""

    def __init__(self) -> None:
        self.killed = False

    def poll(self):
        return -9 if self.killed else None

    def kill(self) -> None:
        self.killed = True


class _FakeWorker:
    def __init__(self) -> None:
        self._proc = _FakeProc()
        self._loaded = True


class _RegistryWithLoadedWorker:
    def __init__(self) -> None:
        self.worker = _FakeWorker()
        self._generators = {"ext/model": self.worker}
        self._active_id = "ext/model"


class CancelEndedJobTests(unittest.TestCase):
    """Cancelling kills the active generator's subprocess so inference stops at
    once. That is only right while the job being cancelled is still pending or
    running: once it has ended, that subprocess belongs to whatever is generating
    now (or holds the warm model), and killing it fails that other generation or
    forces the next one to reload the model from scratch."""

    def setUp(self) -> None:
        self._prev_generation_registry = generation.generator_registry
        self._prev_runs_registry = workflow_runs.generator_registry
        self.registry = _RegistryWithLoadedWorker()
        generation.generator_registry = self.registry
        workflow_runs.generator_registry = self.registry
        _clear_job_stores()

    def tearDown(self) -> None:
        generation.generator_registry = self._prev_generation_registry
        workflow_runs.generator_registry = self._prev_runs_registry
        _clear_job_stores()

    def _file_job(self, job_id: str, status: str) -> None:
        generation._jobs[job_id] = JobStatus(job_id=job_id, status=status, progress=50)
        generation._cancel_events[job_id] = threading.Event()

    def test_cancelling_a_finished_job_leaves_the_active_worker_alone(self) -> None:
        self._file_job("finished-job", "done")
        proc = self.registry.worker._proc

        asyncio.run(generation.cancel_job("finished-job"))

        self.assertEqual(generation._jobs["finished-job"].status, "done")
        self.assertFalse(proc.killed)
        self.assertIs(self.registry.worker._proc, proc)
        self.assertTrue(self.registry.worker._loaded)

    def test_cancelling_a_failed_run_leaves_the_active_worker_alone(self) -> None:
        self._file_job("failed-run", "error")
        proc = self.registry.worker._proc

        asyncio.run(workflow_runs.cancel_run("failed-run"))

        self.assertEqual(generation._jobs["failed-run"].status, "error")
        self.assertFalse(proc.killed)
        self.assertIs(self.registry.worker._proc, proc)
        self.assertTrue(self.registry.worker._loaded)

    def test_cancelling_a_running_job_still_stops_the_worker(self) -> None:
        self._file_job("running-job", "running")
        proc = self.registry.worker._proc

        asyncio.run(generation.cancel_job("running-job"))

        self.assertEqual(generation._jobs["running-job"].status, "cancelled")
        self.assertTrue(proc.killed)
        self.assertIsNone(self.registry.worker._proc)
        self.assertFalse(self.registry.worker._loaded)

    def test_cancelling_a_running_run_still_stops_the_worker(self) -> None:
        self._file_job("running-run", "running")
        proc = self.registry.worker._proc

        asyncio.run(workflow_runs.cancel_run("running-run"))

        self.assertEqual(generation._jobs["running-run"].status, "cancelled")
        self.assertTrue(proc.killed)
        self.assertIsNone(self.registry.worker._proc)
        self.assertFalse(self.registry.worker._loaded)


if __name__ == "__main__":
    unittest.main()
