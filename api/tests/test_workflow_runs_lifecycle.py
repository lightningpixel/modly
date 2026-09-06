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


if __name__ == "__main__":
    unittest.main()
