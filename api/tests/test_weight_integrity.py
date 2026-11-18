import asyncio
import tempfile
import threading
import unittest
from pathlib import Path

import routers.generation as generation
import services.generator_registry as registry
from schemas.generation import JobStatus
from services.generator_registry import GeneratorRegistry
from services.weight_integrity import (
    IncompleteModelWeightsError,
    incomplete_weights_message,
)

# The tail of the traceback reported in issue #389 (TripoSG, diffusers).
TRUNCATED_SAFETENSORS = (
    "Traceback (most recent call last):\n"
    "safetensors._safetensors_rust.SafetensorError: Error while deserializing header: "
    "incomplete metadata, file not fully covered\n"
    "OSError: Unable to load weights from checkpoint file for "
    "'C:\\models\\triposg\\generate\\transformer\\diffusion_pytorch_model.safetensors' "
    "at 'C:\\models\\triposg\\generate\\transformer\\diffusion_pytorch_model.safetensors'."
)


class _FailingLoadGenerator:
    DISPLAY_NAME = "Fallback"
    VRAM_GB = 1

    def __init__(self, error: Exception) -> None:
        self.error = error

    def is_downloaded(self) -> bool:
        return True

    def is_loaded(self) -> bool:
        return False

    def load(self) -> None:
        raise self.error


class IncompleteWeightsMessageTests(unittest.TestCase):
    def test_truncated_safetensors_names_the_file_and_the_fix(self) -> None:
        message = incomplete_weights_message("TripoSG", RuntimeError(TRUNCATED_SAFETENSORS))
        self.assertIn("model files for TripoSG are incomplete", message)
        self.assertIn("transformer\\diffusion_pytorch_model.safetensors", message)
        self.assertIn("Models page", message)
        self.assertNotIn("Traceback", message)

    def test_truncated_torch_archive_is_recognised(self) -> None:
        error = RuntimeError(
            "PytorchStreamReader failed reading zip archive: failed finding central directory"
        )
        self.assertIsNotNone(incomplete_weights_message("Demo", error))

    def test_unrelated_load_errors_are_left_alone(self) -> None:
        self.assertIsNone(
            incomplete_weights_message("Demo", RuntimeError("CUDA out of memory"))
        )


class RegistryLoadTests(unittest.TestCase):
    def _registry(self, error: Exception) -> GeneratorRegistry:
        reg = GeneratorRegistry()
        reg._generators["triposg/generate"] = _FailingLoadGenerator(error)
        reg._manifests["triposg/generate"] = {"name": "TripoSG"}
        return reg

    def test_truncated_weights_raise_a_short_actionable_error(self) -> None:
        reg = self._registry(RuntimeError(TRUNCATED_SAFETENSORS))
        with self.assertRaises(IncompleteModelWeightsError) as raised:
            reg.get_ready_generator("triposg/generate")
        self.assertIn("TripoSG", str(raised.exception))
        self.assertIsInstance(raised.exception.__cause__, RuntimeError)

    def test_other_load_errors_propagate_unchanged(self) -> None:
        original = RuntimeError("CUDA out of memory")
        reg = self._registry(original)
        with self.assertRaises(RuntimeError) as raised:
            reg.get_ready_generator("triposg/generate")
        self.assertIs(raised.exception, original)


class GenerationJobErrorTests(unittest.TestCase):
    def setUp(self) -> None:
        self._prev_registry = generation.generator_registry
        self._prev_ws = registry.WORKSPACE_DIR
        self._tmp = tempfile.TemporaryDirectory()
        registry.WORKSPACE_DIR = Path(self._tmp.name)

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

    def test_job_error_is_the_short_message_not_the_traceback(self) -> None:
        class _Registry:
            def assert_weight_variant_installed(self, params, model_id=None) -> None:
                pass

            def active_status(self) -> dict:
                return {"loaded": True, "name": "TripoSG", "downloaded": True}

            def get_active(self):
                raise IncompleteModelWeightsError("The model files for TripoSG are incomplete.")

        generation.generator_registry = _Registry()
        job_id = "job-incomplete-weights"
        generation._jobs[job_id] = JobStatus(job_id=job_id, status="pending", progress=0)
        generation._cancel_events[job_id] = threading.Event()
        asyncio.run(generation._run_generation(job_id, b"img", {}, "Coll"))

        job = generation._jobs[job_id]
        self.assertEqual(job.status, "error")
        self.assertEqual(job.error, "The model files for TripoSG are incomplete.")


if __name__ == "__main__":
    unittest.main()
