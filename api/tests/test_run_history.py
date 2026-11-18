import asyncio
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException

import routers.generation as generation
import routers.optimize as optimize
import routers.workflow_runs as workflow_runs
import services.run_history as run_history_module
from schemas.generation import GenerateFromArtifactRequest, JobStatus
from schemas.runs import RunRecord, RunStep
from services.mesh_ops import MeshOpExecutionError, MeshOpResult
from services.run_history import (
    INTERRUPTED_ERROR,
    MAX_STEPS,
    RUN_HISTORY_FILENAME,
    RunHistoryStore,
)


def _record(run_id: str, status: str = "done", created_at: float = 1000.0, kind: str = "generation") -> RunRecord:
    return RunRecord(id=run_id, kind=kind, status=status, created_at=created_at)


class _TempStoreCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmp.name)
        self.path = self.workspace / RUN_HISTORY_FILENAME
        self.store = RunHistoryStore()
        self.store.start(lambda: self.path)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def reopen(self, max_records: int | None = None) -> RunHistoryStore:
        """A fresh store on the same file: what the next app start sees."""
        store = RunHistoryStore(max_records or self.store.max_records)
        store.start(lambda: self.path)
        return store


class RunHistoryStoreTests(_TempStoreCase):
    def test_inert_until_started(self) -> None:
        store = RunHistoryStore()
        store.begin("a", "generation")
        store.save(_record("b"))
        self.assertEqual(store.list(), ([], 0))
        self.assertIsNone(store.get("b"))

    def test_lifecycle_is_recorded_with_steps_and_duration(self) -> None:
        self.store.begin("run-1", "generation", model_id="sf3d", inputs={"image": "a.png"}, params={"seed": 1})
        self.assertEqual(self.store.get("run-1").status, "pending")
        self.store.mark_running("run-1")
        self.store.step("run-1", "Loading SF3D…")
        self.store.step("run-1", "Sampling 1/50")
        self.store.step("run-1", "Sampling 2/50")  # same step, only the counter moved
        self.store.step("run-1", "Exporting")
        self.store.finish("run-1", "done", output_path="Default/out.glb")

        record = self.reopen().get("run-1")
        self.assertEqual(record.status, "done")
        self.assertEqual(record.model_id, "sf3d")
        self.assertEqual(record.inputs, {"image": "a.png"})
        self.assertEqual(record.params, {"seed": 1})
        self.assertEqual(record.output_path, "Default/out.glb")
        self.assertEqual([s.name for s in record.steps], ["Loading SF3D…", "Sampling 1/50", "Exporting"])
        self.assertTrue(all(s.ended_at is not None and s.status == "done" for s in record.steps))
        self.assertIsNotNone(record.duration_s)
        self.assertGreaterEqual(record.duration_s, 0)

    def test_steps_are_capped(self) -> None:
        self.store.begin("r", "generation")
        for i in range(MAX_STEPS + 20):
            self.store.step("r", f"step {chr(65 + i % 26)}{chr(65 + i // 26)}")
        self.store.finish("r", "done")
        self.assertEqual(len(self.store.get("r").steps), MAX_STEPS)

    def test_error_and_cancel_are_final(self) -> None:
        self.store.begin("bad", "generation")
        self.store.finish("bad", "error", error="x" * 10_000)
        self.store.begin("stop", "generation")
        self.store.finish("stop", "cancelled")
        self.store.finish("stop", "done")  # a late worker return must not overwrite it

        reopened = self.reopen()
        bad = reopened.get("bad")
        self.assertEqual(bad.status, "error")
        self.assertLessEqual(len(bad.error), run_history_module.MAX_ERROR_CHARS)
        self.assertEqual(reopened.get("stop").status, "cancelled")

    def test_list_is_newest_first_with_paging(self) -> None:
        for i in range(5):
            self.store.save(_record(f"r{i}", created_at=1000.0 + i))
        page, total = self.store.list(limit=2, offset=1)
        self.assertEqual(total, 5)
        self.assertEqual([r.id for r in page], ["r3", "r2"])
        page, total = self.store.list(limit=10, offset=4)
        self.assertEqual([r.id for r in page], ["r0"])

    def test_list_filters_by_status_and_kind(self) -> None:
        self.store.save(_record("ok", "done", 1))
        self.store.save(_record("bad", "error", 2))
        self.store.save(_record("stop", "cancelled", 3, kind="workflow"))
        page, total = self.store.list(statuses=["error", "cancelled"])
        self.assertEqual((total, [r.id for r in page]), (2, ["stop", "bad"]))
        page, total = self.store.list(kinds=["workflow"])
        self.assertEqual([r.id for r in page], ["stop"])

    def test_retention_cap_drops_oldest_finished_runs(self) -> None:
        store = RunHistoryStore(max_records=3)
        store.start(lambda: self.path)
        store.begin("live", "generation")  # oldest, but still running: kept
        store.mark_running("live")
        for i in range(4):
            store.save(_record(f"r{i}", created_at=time.time() + 1 + i))
        ids = {r.id for r in store.list(limit=50)[0]}
        self.assertEqual(ids, {"live", "r2", "r3"})
        on_disk = json.loads(self.path.read_text(encoding="utf-8"))["runs"]
        self.assertEqual(len(on_disk), 3)

    def test_restart_marks_in_flight_runs_interrupted(self) -> None:
        self.store.begin("queued", "generation")
        self.store.begin("busy", "generation")
        self.store.mark_running("busy")
        self.store.step("busy", "Generating")
        self.store.save(_record("finished", "done"))

        reopened = self.reopen()  # the old process died without stop()
        for run_id in ("queued", "busy"):
            record = reopened.get(run_id)
            self.assertEqual(record.status, "interrupted")
            self.assertEqual(record.error, INTERRUPTED_ERROR)
        self.assertEqual(reopened.get("finished").status, "done")
        # ... and it is written back, so the next reader agrees.
        raw = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertEqual({r["id"]: r["status"] for r in raw["runs"]}["busy"], "interrupted")

    def test_stop_marks_live_runs_interrupted(self) -> None:
        self.store.begin("busy", "generation")
        self.store.mark_running("busy")
        self.store.stop()
        self.assertEqual(self.reopen().get("busy").status, "interrupted")

    def test_missing_file_is_an_empty_history(self) -> None:
        self.assertEqual(self.store.list(), ([], 0))
        self.assertFalse(self.path.exists())

    def test_corrupt_file_is_moved_aside(self) -> None:
        self.path.write_text("{not json", encoding="utf-8")
        store = self.reopen()
        self.assertEqual(store.list(), ([], 0))
        store.save(_record("fresh"))
        self.assertEqual(self.reopen().get("fresh").status, "done")
        self.assertEqual(len(list(self.workspace.glob(f"{RUN_HISTORY_FILENAME}.corrupt-*"))), 1)

    def test_invalid_entries_are_skipped(self) -> None:
        good = _record("good").model_dump(mode="json")
        self.path.write_text(json.dumps({"version": 1, "runs": [good, {"id": "x"}, 42]}), encoding="utf-8")
        page, total = self.reopen().list()
        self.assertEqual([r.id for r in page], ["good"])

    def test_writes_are_atomic_and_leave_no_temp_files(self) -> None:
        for i in range(3):
            self.store.save(_record(f"r{i}"))
        self.assertEqual(sorted(p.name for p in self.workspace.iterdir()), [RUN_HISTORY_FILENAME])

    def test_write_failure_does_not_raise(self) -> None:
        with patch("services.run_history.os.replace", side_effect=PermissionError("locked")):
            self.store.save(_record("r"))  # logged, not raised
        self.assertEqual(self.store.get("r").status, "done")  # still served from memory

    def test_follows_a_relocated_workspace(self) -> None:
        other = self.workspace / "moved" / RUN_HISTORY_FILENAME
        current = {"path": self.path}
        store = RunHistoryStore()
        store.start(lambda: current["path"])
        store.begin("live", "generation")
        store.mark_running("live")
        current["path"] = other
        store.finish("live", "done")
        reloaded = RunHistoryStore()
        reloaded.start(lambda: other)
        self.assertEqual(reloaded.get("live").status, "done")


class ParentRunTests(_TempStoreCase):
    def _child(self, run_id: str, parent: str, created_at: float) -> RunRecord:
        record = _record(run_id, created_at=created_at)
        record.parent_run_id = parent
        return record

    def test_parent_run_id_is_persisted(self) -> None:
        self.store.begin("child", "generation", model_id="sf3d", parent_run_id="wf-run")
        self.assertEqual(self.reopen().get("child").parent_run_id, "wf-run")

    def test_old_history_without_parent_run_id_loads(self) -> None:
        self.path.write_text(json.dumps({"version": 1, "runs": [
            {"id": "legacy", "kind": "generation", "status": "done", "created_at": 1000.0},
        ]}), encoding="utf-8")
        record = self.reopen().get("legacy")
        self.assertEqual(record.status, "done")
        self.assertIsNone(record.parent_run_id)

    def test_top_level_leaves_out_children_and_counts_accordingly(self) -> None:
        self.store.save(_record("wf", kind="workflow", created_at=1000.0))
        self.store.save(self._child("c1", "wf", 1001.0))
        self.store.save(self._child("c2", "wf", 1002.0))
        self.store.save(_record("solo", created_at=1003.0))
        page, total = self.store.list(top_level=True)
        self.assertEqual(([r.id for r in page], total), (["solo", "wf"], 2))
        page, total = self.store.list()
        self.assertEqual(total, 4)

    def test_children_are_in_execution_order(self) -> None:
        self.store.save(self._child("late", "wf", 1005.0))
        self.store.save(self._child("early", "wf", 1001.0))
        self.store.save(self._child("other", "wf-2", 1002.0))
        self.store.save(_record("wf", kind="workflow"))
        self.assertEqual([r.id for r in self.store.children("wf")], ["early", "late"])
        self.assertEqual(self.store.children("nobody"), [])

    def test_running_record_lists_its_live_steps_without_rewriting_the_file(self) -> None:
        self.store.begin("live", "generation")
        self.store.mark_running("live")
        on_disk = self.path.read_text(encoding="utf-8")
        self.store.step("live", "Loading")
        self.store.step("live", "Sampling 3/50")
        page, _ = self.store.list(statuses=["running"])
        self.assertEqual([s.name for s in page[0].steps], ["Loading", "Sampling 3/50"])
        self.assertIsNone(page[0].steps[-1].ended_at)
        self.assertEqual(self.path.read_text(encoding="utf-8"), on_disk)
        # The list hands out copies: a caller cannot corrupt the live record.
        page[0].steps.clear()
        self.assertEqual(len(self.store.get("live").steps), 2)


class _RouterHistoryCase(_TempStoreCase):
    """Points the routers' shared store at a temp workspace for one test."""

    def setUp(self) -> None:
        super().setUp()
        patcher = patch.object(run_history_module.run_history, "_path_provider", None)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.shared = run_history_module.run_history
        self.shared.start(lambda: self.path)
        self.addCleanup(self.shared.stop)
        for store in (generation._jobs, generation._cancel_events, generation._cancelled,
                      generation._completed_at, generation._job_generators):
            store.clear()


class ListRunsEndpointTests(_RouterHistoryCase):
    def test_lists_with_paging_and_status_filter(self) -> None:
        for i, status in enumerate(["done", "error", "cancelled", "interrupted", "done"]):
            self.shared.save(_record(f"r{i}", status, 1000.0 + i))
        page = asyncio.run(workflow_runs.list_runs(status=["error", "cancelled"], kind=None, limit=1, offset=0))
        self.assertEqual(page.total, 2)
        self.assertEqual([r.id for r in page.runs], ["r2"])
        page = asyncio.run(workflow_runs.list_runs(status=None, kind=None, limit=50, offset=0))
        self.assertEqual(page.total, 5)
        self.assertEqual(page.runs[0].id, "r4")

    def test_route_is_mounted_at_the_collection_root(self) -> None:
        paths = {(route.path, tuple(sorted(route.methods))) for route in workflow_runs.router.routes}
        self.assertIn(("", ("GET",)), paths)
        self.assertIn(("/{run_id}", ("PUT",)), paths)
        self.assertIn(("/{run_id}/children", ("GET",)), paths)

    def test_top_level_filter_and_children_route(self) -> None:
        self.shared.save(_record("wf", kind="workflow", created_at=1000.0))
        for i in range(2):
            child = _record(f"c{i}", created_at=1001.0 + i)
            child.parent_run_id = "wf"
            self.shared.save(child)
        page = asyncio.run(workflow_runs.list_runs(status=None, kind=None, limit=50, offset=0, top_level=True))
        self.assertEqual(([r.id for r in page.runs], page.total), (["wf"], 1))
        page = asyncio.run(workflow_runs.list_runs(status=None, kind=None, limit=50, offset=0))
        self.assertEqual(page.total, 3)
        self.assertEqual(page.runs[0].parent_run_id, "wf")
        children = asyncio.run(workflow_runs.list_run_children("wf"))
        self.assertEqual([r.id for r in children.runs], ["c0", "c1"])
        self.assertEqual(asyncio.run(workflow_runs.list_run_children("c0")).runs, [])

    def test_children_path_does_not_resolve_to_get_run(self) -> None:
        from starlette.routing import Match
        scope = {"type": "http", "method": "GET", "path": "/wf/children"}
        matched = [r.endpoint for r in workflow_runs.router.routes
                   if r.matches(scope)[0] == Match.FULL]
        self.assertEqual(matched, [workflow_runs.list_run_children])

    def test_get_run_falls_back_to_history_after_purge(self) -> None:
        record = _record("old", "done")
        record.output_path = "Default/out.glb"
        self.shared.save(record)
        status = asyncio.run(workflow_runs.get_run("old"))
        self.assertEqual(status.status, "done")
        self.assertEqual(status.output_url, "/workspace/Default/out.glb")
        with self.assertRaises(HTTPException):
            asyncio.run(workflow_runs.get_run("unknown"))


class PutWorkflowRunTests(_RouterHistoryCase):
    def _put(self, run_id: str, **fields) -> RunRecord:
        body = workflow_runs.WorkflowRunRecordIn(**fields)
        return asyncio.run(workflow_runs.put_workflow_run_record(run_id, body))

    def test_upserts_a_workflow_record(self) -> None:
        self._put("wf-run", workflow_id="wf", workflow_name="Flow", status="running",
                  created_at=1000.0, started_at=1000.0,
                  steps=[RunStep(name="Mesh", node_id="n1", started_at=1000.0)])
        self._put("wf-run", workflow_id="wf", workflow_name="Flow", status="done",
                  started_at=1000.0, ended_at=1012.5, output_path="Workflows/out.glb",
                  steps=[RunStep(name="Mesh", node_id="n1", status="done", started_at=1000.0, ended_at=1012.5)])
        record = self.reopen().get("wf-run")
        self.assertEqual(record.kind, "workflow")
        self.assertEqual(record.status, "done")
        self.assertEqual(record.created_at, 1000.0)  # kept from the first report
        self.assertEqual(record.duration_s, 12.5)
        self.assertEqual(record.output_path, "Workflows/out.glb")

    def test_running_workflow_is_interrupted_on_restart(self) -> None:
        self._put("wf-run", status="running", created_at=1000.0)
        self.assertEqual(self.reopen().get("wf-run").status, "interrupted")

    def test_refuses_to_overwrite_a_backend_run(self) -> None:
        self.shared.save(_record("gen"))
        with self.assertRaises(HTTPException) as ctx:
            self._put("gen", status="done")
        self.assertEqual(ctx.exception.status_code, 409)


class _Gen:
    def __init__(self, fail: bool = False, out_dir: Path | None = None) -> None:
        self.fail = fail
        self.outputs_dir = out_dir

    def generate(self, image_bytes, params, progress_cb, cancel_event=None):
        progress_cb(10, "Generating")
        if self.fail:
            raise RuntimeError("boom")
        out = Path(self.outputs_dir) / "mesh.glb"
        out.write_bytes(b"glb")
        return str(out)


class _Registry:
    def __init__(self, gen: _Gen) -> None:
        self.gen = gen

    def assert_weight_variant_installed(self, params, model_id) -> None:
        pass

    def get_generator(self, model_id):
        return self.gen

    def activate_ready_generator(self, model_id):
        return self.gen

    def model_status(self, model_id):
        return {"loaded": True, "name": model_id, "downloaded": True}


class GenerationRecordingTests(_RouterHistoryCase):
    def setUp(self) -> None:
        super().setUp()
        ws = patch.object(generation.registry, "WORKSPACE_DIR", self.workspace)
        ws.start()
        self.addCleanup(ws.stop)

    def _run(self, job_id: str, gen: _Gen) -> None:
        generation._jobs[job_id] = JobStatus(job_id=job_id, status="pending")
        generation._cancel_events[job_id] = threading.Event()
        generation.record_job_filed(job_id, "demo/model", {"image": "in.png"}, {"seed": 3}, "Default")
        with patch.object(generation, "generator_registry", _Registry(gen)):
            asyncio.run(generation._run_generation(job_id, b"img", {"seed": 3}, "Default", "mesh", "demo/model"))

    def test_successful_generation_is_recorded_done(self) -> None:
        self._run("ok", _Gen())
        record = self.reopen().get("ok")
        self.assertEqual(record.status, "done")
        self.assertEqual(record.model_id, "demo/model")
        self.assertEqual(record.params, {"seed": 3, "collection": "Default"})
        self.assertEqual(record.output_path, "Default/mesh.glb")
        self.assertEqual([s.name for s in record.steps], ["Generating"])
        self.assertIsNotNone(record.duration_s)

    def test_failed_generation_is_recorded_with_its_error(self) -> None:
        self._run("bad", _Gen(fail=True))
        record = self.reopen().get("bad")
        self.assertEqual(record.status, "error")
        self.assertIn("boom", record.error)

    def test_cancel_is_recorded_immediately(self) -> None:
        generation._jobs["c"] = JobStatus(job_id="c", status="running")
        generation.record_job_filed("c", "demo/model", {}, {}, "Default")
        asyncio.run(generation.cancel_job("c"))
        self.assertEqual(self.reopen().get("c").status, "cancelled")


class _FakeUpload:
    filename = "in.png"
    content_type = "image/png"

    async def read(self) -> bytes:
        return b"img"


class _EndpointRegistry:
    def get_generator(self, model_id):
        return object()

    def get_manifest(self, model_id):
        return {"output": "mesh", "inputs": ["image", "scene"]}


class GenerationParentRunTests(_RouterHistoryCase):
    def setUp(self) -> None:
        super().setUp()
        for patcher in (patch.object(generation.registry, "WORKSPACE_DIR", self.workspace),
                        patch.object(generation, "generator_registry", _EndpointRegistry())):
            patcher.start()
            self.addCleanup(patcher.stop)

    def _from_image(self, **extra) -> str:
        response = asyncio.run(generation.generate_from_image(
            BackgroundTasks(), image=_FakeUpload(), model_id="demo/model", collection="Workflows",
            remesh="none", enable_texture=False, texture_resolution=1024, params="{}", **extra,
        ))
        return response["job_id"]

    def test_from_image_records_the_parent_run(self) -> None:
        job_id = self._from_image(parent_run_id="wf-run")
        self.assertEqual(self.reopen().get(job_id).parent_run_id, "wf-run")
        self.assertEqual([r.id for r in self.shared.children("wf-run")], [job_id])

    def test_from_image_without_or_with_blank_parent_is_top_level(self) -> None:
        self.assertIsNone(self.shared.get(self._from_image()).parent_run_id)
        self.assertIsNone(self.shared.get(self._from_image(parent_run_id="  ")).parent_run_id)

    def test_from_image_refuses_an_oversized_parent_id(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            self._from_image(parent_run_id="x" * 201)
        self.assertEqual(ctx.exception.status_code, 400)

    def test_from_artifact_records_the_parent_run(self) -> None:
        scene = self.workspace / "Workflows" / "room"
        scene.mkdir(parents=True)
        (scene / "scene-manifest.json").write_text(
            json.dumps({"schema": "modly.scene-manifest.v1", "sceneRoot": ".", "assets": []}))
        response = asyncio.run(generation.generate_from_artifact(GenerateFromArtifactRequest(
            input_kind="scene", input_path="Workflows/room", model_id="demo/scene",
            parent_run_id="wf-run",
        ), BackgroundTasks()))
        self.assertEqual(self.reopen().get(response["job_id"]).parent_run_id, "wf-run")


class MeshOpRecordingTests(_RouterHistoryCase):
    def setUp(self) -> None:
        super().setUp()
        ws = patch.object(optimize.registry, "WORKSPACE_DIR", self.workspace)
        ws.start()
        self.addCleanup(ws.stop)
        self.mesh = self.workspace / "Default" / "in.glb"
        self.mesh.parent.mkdir()
        self.mesh.write_bytes(b"glb")

    def test_mesh_writing_op_is_recorded(self) -> None:
        out = self.workspace / "Default" / "out.glb"
        with patch.object(optimize.mesh_ops_registry, "run", return_value=MeshOpResult(file_path=out)):
            optimize._run_operation("decimate", self.mesh, {"target_faces": 100}, out)
        page, _ = self.reopen().list()
        self.assertEqual(len(page), 1)
        self.assertEqual((page[0].kind, page[0].op_id, page[0].status), ("mesh_op", "decimate", "done"))
        self.assertEqual(page[0].inputs, {"mesh": "Default/in.glb"})
        self.assertEqual(page[0].output_path, "Default/out.glb")

    def test_failed_op_is_recorded(self) -> None:
        with patch.object(optimize.mesh_ops_registry, "run", side_effect=MeshOpExecutionError("broken")):
            with self.assertRaises(HTTPException):
                optimize._run_operation("smooth", self.mesh, {})
        page, _ = self.reopen().list()
        self.assertEqual((page[0].status, page[0].error), ("error", "broken"))

    def test_report_only_op_is_not_recorded(self) -> None:
        with patch.object(optimize.mesh_ops_registry, "run", return_value=MeshOpResult(file_path=None)):
            optimize._run_operation("inspect_mesh", self.mesh, {})
        self.assertEqual(self.reopen().list(), ([], 0))


if __name__ == "__main__":
    unittest.main()
