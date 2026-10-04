import asyncio
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi import BackgroundTasks, HTTPException
from pydantic import ValidationError

import routers.generation as generation
import services.generator_registry as registry
from schemas.generation import GenerateFromArtifactRequest
from services.artifact_input import validate_artifact_input


class _Registry:
    def __init__(self):
        self.switched = False
    def get_generator(self, model_id): return object()
    def get_manifest(self, model_id): return {"input": "scene"}
    def switch_model(self, model_id): self.switched = True
    def assert_weight_variant_installed(self, params, model_id=None): pass


class SceneGenerationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self.tmp.name) / "workspace"
        self.scene = self.workspace / "Workflows" / "room"
        self.scene.mkdir(parents=True)
        self.manifest = self.scene / "scene-manifest.json"
        self.manifest.write_text(json.dumps({"schema": "modly.scene-manifest.v1", "sceneRoot": ".", "assets": []}))
        self.registry = _Registry()
        self.patches = [patch.object(generation, "generator_registry", self.registry), patch.object(registry, "WORKSPACE_DIR", self.workspace)]
        for item in self.patches: item.start()

    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        generation._jobs.clear(); generation._cancel_events.clear(); generation._cancelled.clear(); generation._completed_at.clear(); generation._job_generators.clear()
        self.tmp.cleanup()

    def test_generic_route_queues_typed_scene_and_strips_reserved_params(self):
        tasks = BackgroundTasks()
        result = asyncio.run(generation.generate_from_artifact(GenerateFromArtifactRequest(
            input_kind="scene", input_path="Workflows/room", model_id="demo/scene",
            params={"artifact_path": "/etc/passwd", "input_kind": "image", "quality": "high"},
        ), tasks))
        queued = tasks.tasks[0]
        self.assertEqual(queued.args[1].kind, "scene")
        self.assertEqual(queued.args[1].path, self.manifest.resolve())
        self.assertEqual(queued.args[2]["scene_manifest_path"], str(self.manifest.resolve()))
        self.assertNotIn("artifact_path", queued.args[2])
        self.assertNotIn("input_kind", queued.args[2])
        self.assertEqual(queued.args[5], "demo/scene")
        self.assertEqual(result["job_id"], queued.args[0])
        self.assertFalse(self.registry.switched)

    def test_generic_route_rejects_unsupported_kind_and_model_mismatch(self):
        for kind in ("capture", "image"):
            with self.subTest(kind=kind), self.assertRaises(ValidationError):
                GenerateFromArtifactRequest(
                    input_kind=kind, input_path="Workflows/room", model_id="demo/scene")
        self.registry.get_manifest = lambda _model_id: {"input": "image"}
        with self.assertRaises(HTTPException) as caught:
            asyncio.run(generation.generate_from_artifact(GenerateFromArtifactRequest(
                input_kind="scene", input_path="Workflows/room", model_id="demo/image"), BackgroundTasks()))
        self.assertEqual(caught.exception.status_code, 400)

    def test_generic_route_queues_video_without_forgeable_transport_params(self):
        video = self.workspace / "Workflows" / "clip.mp4"
        video.write_bytes(b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2")
        self.registry.get_manifest = lambda _model_id: {"input": "video", "output": "mesh"}
        tasks = BackgroundTasks()
        asyncio.run(generation.generate_from_artifact(GenerateFromArtifactRequest(
            input_kind="video", input_path="Workflows/clip.mp4", model_id="demo/video",
            params={"video_path": "/etc/passwd", "input_path": "fake", "quality": "high"},
        ), tasks))
        queued = tasks.tasks[0]
        self.assertEqual(queued.args[1].kind, "video")
        self.assertEqual(queued.args[1].path, video.resolve())
        self.assertNotIn("video_path", queued.args[2])
        self.assertNotIn("input_path", queued.args[2])
        self.assertEqual(queued.args[5], "demo/video")

    def test_rejects_traversal_before_switch_or_queue(self):
        with self.assertRaises(HTTPException):
            asyncio.run(generation.generate_from_artifact(GenerateFromArtifactRequest(
                input_kind="scene", input_path="../outside", model_id="demo/scene"), BackgroundTasks()))
        self.assertFalse(self.registry.switched)

    def test_queued_scene_job_is_pinned_to_requested_model(self):
        calls = []

        class Generator:
            outputs_dir = None
            def is_loaded(self): return True
            def generate_artifact(self, kind, path, params, progress_cb, cancel_event=None):
                calls.append(("model-a", kind, path))
                output = Path(self.outputs_dir) / "result.glb"
                output.write_bytes(b"glb")
                return output

        generator = Generator()
        registry_stub = type("Registry", (), {
            "assert_weight_variant_installed": lambda self, params, model_id=None: None,
            "model_status": lambda self, model_id: {"name": model_id, "downloaded": True, "loaded": True},
            "get_generator": lambda self, model_id: generator if model_id == "demo/a" else (_ for _ in ()).throw(ValueError(f"Unknown model ID: {model_id}")),
            "activate_ready_generator": lambda self, model_id: generator if model_id == "demo/a" else (_ for _ in ()).throw(ValueError(f"Unknown model ID: {model_id}")),
            "get_active": lambda self: (_ for _ in ()).throw(AssertionError("mutable active model must not be used")),
        })()
        job_id = "pinned-scene"
        generation._jobs[job_id] = generation.JobStatus(job_id=job_id, status="pending", progress=0)
        generation._cancel_events[job_id] = __import__("threading").Event()
        with patch.object(generation, "generator_registry", registry_stub):
            asyncio.run(generation._run_generation(
                job_id, generation.TypedArtifactInput("scene", self.manifest.resolve()), {},
                "Workflows", "mesh", "demo/a",
            ))
        self.assertEqual(calls[0][0], "model-a")
        self.assertEqual(generation._jobs[job_id].status, "done")

    def test_missing_pinned_model_fails_actionably(self):
        registry_stub = type("Registry", (), {
            "assert_weight_variant_installed": lambda self, params, model_id=None: None,
            "model_status": lambda self, model_id: {"name": model_id, "downloaded": True, "loaded": False},
            "get_generator": lambda self, model_id: object(),
            "activate_ready_generator": lambda self, model_id: (_ for _ in ()).throw(ValueError(f"Unknown model ID: {model_id}")),
            "get_active": lambda self: (_ for _ in ()).throw(AssertionError("must not use active model")),
        })()
        job_id = "missing-scene"
        generation._jobs[job_id] = generation.JobStatus(job_id=job_id, status="pending", progress=0)
        generation._cancel_events[job_id] = __import__("threading").Event()
        with patch.object(generation, "generator_registry", registry_stub):
            asyncio.run(generation._run_generation(
                job_id, generation.TypedArtifactInput("scene", self.manifest.resolve()), {},
                "Workflows", "mesh", "demo/missing",
            ))
        self.assertEqual(generation._jobs[job_id].status, "error")
        self.assertIn("Unknown model ID: demo/missing", generation._jobs[job_id].error)

    def test_video_job_stays_pinned_and_receives_snapshot_and_cancellation_event(self):
        video = self.workspace / "Workflows" / "clip.mp4"
        video.write_bytes(b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2")
        artifact = validate_artifact_input(self.workspace, "video", "Workflows/clip.mp4")
        calls = []

        class Generator:
            outputs_dir = None
            def is_loaded(self): return True
            def generate_artifact(self, kind, path, params, progress_cb, cancel_event=None,
                                  artifact_snapshot=None):
                calls.append((kind, path, cancel_event, artifact_snapshot))
                output = Path(self.outputs_dir) / "result.glb"
                output.write_bytes(b"glb")
                return output

        generator = Generator()
        registry_stub = type("Registry", (), {
            "assert_weight_variant_installed": lambda self, params, model_id=None: None,
            "model_status": lambda self, model_id: {"name": model_id, "downloaded": True, "loaded": True},
            "get_generator": lambda self, model_id: generator if model_id == "demo/video" else None,
            "activate_ready_generator": lambda self, model_id: generator if model_id == "demo/video" else None,
            "get_active": lambda self: (_ for _ in ()).throw(AssertionError("active model must not be used")),
        })()
        job_id = "pinned-video"
        generation._jobs[job_id] = generation.JobStatus(job_id=job_id, status="pending", progress=0)
        generation._cancel_events[job_id] = threading.Event()
        with patch.object(generation, "generator_registry", registry_stub):
            asyncio.run(generation._run_generation(
                job_id, artifact, {}, "Workflows", "mesh", "demo/video",
            ))
        self.assertEqual(calls[0][:2], ("video", video.resolve()))
        self.assertIs(calls[0][2], generation._cancel_events[job_id])
        self.assertEqual(calls[0][3], artifact.snapshot)

    def test_interleaved_pinned_jobs_serialize_model_lifecycle_and_cancel_exact_job(self):
        class Proc:
            def __init__(self, owner):
                self.owner = owner
                self.alive = True
            def poll(self):
                return None if self.alive else 0
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
            def is_downloaded(self): return True
            def load(self): self.loaded = True
            def unload(self): self.loaded = False
            def generate_artifact(self, kind, path, params, progress_cb, cancel_event=None):
                self.started.set()
                if self.model_id == "demo/a":
                    if cancel_event is None or not cancel_event.wait(2):
                        raise AssertionError("first job was not cancelled")
                    raise generation.GenerationCancelled()
                output = Path(self.outputs_dir) / "result.glb"
                output.write_bytes(b"glb")
                return output

        class Registry:
            def __init__(self):
                self.generators = {model_id: Generator(model_id) for model_id in ("demo/a", "demo/b")}
                self.active_id = "demo/a"
            def assert_weight_variant_installed(self, params, model_id=None): pass
            def get_generator(self, model_id): return self.generators[model_id]
            def model_status(self, model_id):
                gen = self.generators[model_id]
                return {"name": model_id, "downloaded": True, "loaded": gen.loaded}
            def switch_model(self, model_id):
                if model_id != self.active_id:
                    self.generators[self.active_id].unload()
                    self.active_id = model_id
            def activate_ready_generator(self, model_id):
                self.switch_model(model_id)
                gen = self.generators[model_id]
                gen.load()
                if sum(candidate.loaded for candidate in self.generators.values()) != 1:
                    raise AssertionError("more than one generator is resident")
                return gen
            def get_active(self): raise AssertionError("pinned jobs must not consult mutable active state")

        registry_stub = Registry()
        # Reproduce the request interleaving: A switches first, then B switches
        # before either background task has started.
        registry_stub.switch_model("demo/a")
        registry_stub.switch_model("demo/b")
        for job_id in ("job-a", "job-b"):
            generation._jobs[job_id] = generation.JobStatus(job_id=job_id, status="pending", progress=0)
            generation._cancel_events[job_id] = threading.Event()

        async def run_both():
            first = asyncio.create_task(generation._run_generation(
                "job-a", generation.TypedArtifactInput("scene", self.manifest.resolve()), {},
                "Workflows", "mesh", "demo/a",
            ))
            second = asyncio.create_task(generation._run_generation(
                "job-b", generation.TypedArtifactInput("scene", self.manifest.resolve()), {},
                "Workflows", "mesh", "demo/b",
            ))
            started = await asyncio.to_thread(registry_stub.generators["demo/a"].started.wait, 1)
            self.assertTrue(started)
            await asyncio.sleep(0.05)
            self.assertFalse(registry_stub.generators["demo/b"].started.is_set())
            await generation.cancel_job("job-a")
            await asyncio.gather(first, second)

        with patch.object(generation, "generator_registry", registry_stub):
            asyncio.run(run_both())

        self.assertTrue(registry_stub.generators["demo/a"].killed)
        self.assertFalse(registry_stub.generators["demo/b"].killed)
        self.assertEqual(generation._jobs["job-a"].status, "cancelled")
        self.assertEqual(generation._jobs["job-b"].status, "done")
        self.assertEqual(registry_stub.active_id, "demo/b")
        self.assertFalse(registry_stub.generators["demo/a"].loaded)
        self.assertTrue(registry_stub.generators["demo/b"].loaded)

    def test_cancelling_queued_generation_does_not_wedge_later_jobs(self):
        release_first = threading.Event()
        first_started = threading.Event()

        class Generator:
            outputs_dir = None

            def __init__(self):
                self.calls = 0

            def generate(self, image_bytes, params, progress_cb, cancel_event=None):
                self.calls += 1
                call_number = self.calls
                if call_number == 1:
                    first_started.set()
                    if not release_first.wait(2):
                        raise AssertionError("first generation was not released")
                output = Path(self.outputs_dir) / f"result-{call_number}.glb"
                output.write_bytes(b"glb")
                return output

        generator = Generator()
        registry_stub = type("Registry", (), {
            "assert_weight_variant_installed": lambda self, params, model_id=None: None,
            "get_generator": lambda self, model_id: generator,
            "model_status": lambda self, model_id: {
                "name": model_id, "downloaded": True, "loaded": True,
            },
            "activate_ready_generator": lambda self, model_id: generator,
            "get_active": lambda self: (_ for _ in ()).throw(
                AssertionError("pinned jobs must not use mutable active state")
            ),
        })()
        for job_id in ("blocking", "cancelled-waiter", "after-cancel"):
            generation._jobs[job_id] = generation.JobStatus(
                job_id=job_id, status="pending", progress=0,
            )
            generation._cancel_events[job_id] = threading.Event()

        async def run_scenario():
            first = asyncio.create_task(generation._run_generation(
                "blocking", b"image", {}, "Workflows", "mesh", "demo/a",
            ))
            started = await asyncio.to_thread(first_started.wait, 1)
            self.assertTrue(started)

            queued = asyncio.create_task(generation._run_generation(
                "cancelled-waiter", b"image", {}, "Workflows", "mesh", "demo/b",
            ))
            await asyncio.sleep(0)
            queued.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await queued

            release_first.set()
            await asyncio.wait_for(first, 1)
            await asyncio.wait_for(generation._run_generation(
                "after-cancel", b"image", {}, "Workflows", "mesh", "demo/c",
            ), 1)

        with patch.object(generation, "generator_registry", registry_stub):
            asyncio.run(run_scenario())

        self.assertEqual(generation._jobs["cancelled-waiter"].status, "cancelled")
        self.assertEqual(generation._jobs["after-cancel"].status, "done")
        self.assertEqual(generator.calls, 2)

    def test_pinned_jobs_do_not_starve_small_default_executor(self):
        class Generator:
            outputs_dir = None

            def __init__(self):
                self.calls = 0

            def generate(self, image_bytes, params, progress_cb, cancel_event=None):
                self.calls += 1
                output = Path(self.outputs_dir) / f"result-{self.calls}.glb"
                output.write_bytes(b"glb")
                return output

        generator = Generator()
        registry_stub = type("Registry", (), {
            "assert_weight_variant_installed": lambda self, params, model_id=None: None,
            "get_generator": lambda self, model_id: generator,
            "model_status": lambda self, model_id: {
                "name": model_id, "downloaded": True, "loaded": True,
            },
            "activate_ready_generator": lambda self, model_id: generator,
            "get_active": lambda self: (_ for _ in ()).throw(
                AssertionError("pinned jobs must not use mutable active state")
            ),
        })()
        job_ids = ("small-pool-a", "small-pool-b", "small-pool-c")
        for job_id in job_ids:
            generation._jobs[job_id] = generation.JobStatus(
                job_id=job_id, status="pending", progress=0,
            )
            generation._cancel_events[job_id] = threading.Event()

        default_executor = ThreadPoolExecutor(max_workers=2)

        async def run_scenario():
            asyncio.get_running_loop().set_default_executor(default_executor)
            await asyncio.wait_for(asyncio.gather(*(
                generation._run_generation(
                    job_id, b"image", {}, "Workflows", "mesh", f"demo/{job_id}",
                )
                for job_id in job_ids
            )), 2)

        try:
            with patch.object(generation, "generator_registry", registry_stub):
                asyncio.run(run_scenario())
        finally:
            default_executor.shutdown(wait=True)

        self.assertEqual(generator.calls, 3)
        self.assertEqual(
            [generation._jobs[job_id].status for job_id in job_ids],
            ["done", "done", "done"],
        )
