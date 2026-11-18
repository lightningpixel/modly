import asyncio
import unittest

from fastapi import BackgroundTasks, HTTPException

import routers.workflow_runs as workflow_runs
from routers.generation import sanitize_collection


class _FakeUpload:
    """Minimal stand-in for UploadFile: an image content-type and readable bytes."""

    filename = "input.png"

    def __init__(self, content_type: str = "image/png", data: bytes = b"\x89PNG\r\n") -> None:
        self.content_type = content_type
        self._data = data

    async def read(self) -> bytes:
        return self._data


class _FakeGenerator:
    """Declares a params_schema the way BaseGenerator/ExtensionProcess do."""

    def __init__(self, schema: list | None = None) -> None:
        self._schema = schema or []

    def params_schema(self) -> list:
        return self._schema


class _FakeRegistry:
    """Accepts any model id so the route reaches the point where it files the run."""

    def __init__(self, schema: list | None = None) -> None:
        self._gen = _FakeGenerator(schema)

    def get_generator(self, model_id: str) -> object:
        return self._gen

    def get_manifest(self, model_id: str) -> dict:
        return {"output": "mesh"}

    def switch_model(self, model_id: str) -> None:
        pass


class SanitizeCollectionTests(unittest.TestCase):
    def test_keeps_a_plain_name_trimmed(self) -> None:
        self.assertEqual(sanitize_collection("  Exports  "), "Exports")

    def test_empty_or_blank_falls_back_to_default(self) -> None:
        self.assertEqual(sanitize_collection(""), "Default")
        self.assertEqual(sanitize_collection("   "), "Default")

    def test_path_and_wildcard_characters_fall_back_to_default(self) -> None:
        # Any of these would let the name escape the workspace root or fail to create on
        # Windows, so the whole name is refused rather than partly scrubbed.
        for name in ("../evil", "a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b"):
            self.assertEqual(sanitize_collection(name), "Default", name)

    def test_bare_dot_dot_falls_back_to_default(self) -> None:
        # ".." contains none of the blocked characters above, so a character blocklist alone
        # lets it through -- and WORKSPACE_DIR / ".." resolves to the workspace's *parent*,
        # writing the generated mesh outside the sandboxed root. Containment must be checked
        # against the resolved path, not just the spelling.
        self.assertEqual(sanitize_collection(".."), "Default")

    def test_trailing_dots_fall_back_to_default(self) -> None:
        # Windows silently drops trailing dots from the folder it actually creates, so
        # "Exports..." and "Exports" would otherwise land in the very same physical directory
        # -- two collections the caller thinks are distinct merging their output on disk.
        # (A trailing space is already normalized away by the .strip() above, consistently.)
        for name in ("Exports.", "Exports..", "..."):
            self.assertEqual(sanitize_collection(name), "Default", name)


class CreateRunCollectionTests(unittest.TestCase):
    """The canonical /workflow-runs/from-image must file a run where the caller asked (#238)."""

    def setUp(self) -> None:
        self._previous = workflow_runs.generator_registry
        workflow_runs.generator_registry = _FakeRegistry()

    def tearDown(self) -> None:
        workflow_runs.generator_registry = self._previous

    def _collection_forwarded(self, collection: str) -> str:
        background = BackgroundTasks()
        asyncio.run(
            workflow_runs.create_run_from_image(
                background,
                image=_FakeUpload(),
                model_id="sf3d",
                collection=collection,
                params="{}",
            )
        )
        # add_task(_run_generation, ..., collection, output_kind, model_id)
        return background.tasks[0].args[3]

    def test_collection_is_forwarded_to_the_run(self) -> None:
        # The whole point of #238: a run driven over REST/MCP can land in a folder the Library
        # indexes, instead of always being filed under the hardcoded "Default".
        self.assertEqual(self._collection_forwarded("Exports"), "Exports")

    def test_a_blank_collection_becomes_default(self) -> None:
        self.assertEqual(self._collection_forwarded("   "), "Default")

    def test_a_traversing_collection_is_neutralized(self) -> None:
        # The name becomes a workspace subfolder, so a path-separator name must never survive.
        self.assertEqual(self._collection_forwarded("../../etc"), "Default")


class _SwitchTrackingRegistry(_FakeRegistry):
    """Records whether switch_model ran, to prove a rejected request never reaches it."""

    def __init__(self) -> None:
        super().__init__()
        self.switched = False

    def switch_model(self, model_id: str) -> None:
        self.switched = True


class CreateRunRemeshValidationTests(unittest.TestCase):
    """/generate/from-image rejects an invalid remesh with a 400; this endpoint must too."""

    def setUp(self) -> None:
        self._previous = workflow_runs.generator_registry
        workflow_runs.generator_registry = _FakeRegistry()

    def tearDown(self) -> None:
        workflow_runs.generator_registry = self._previous

    def test_invalid_remesh_is_rejected(self) -> None:
        background = BackgroundTasks()
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(
                workflow_runs.create_run_from_image(
                    background,
                    image=_FakeUpload(),
                    model_id="sf3d",
                    collection="Default",
                    params='{"remesh": "garbage"}',
                )
            )
        self.assertEqual(ctx.exception.status_code, 400)

    def test_invalid_remesh_is_rejected_before_switching_the_active_model(self) -> None:
        # switch_model() unloads whatever generator is currently active (a blocking call for
        # subprocess-backed extensions), so a request doomed to a 400 anyway must not pay for
        # -- or force a reload after -- evicting it.
        registry = _SwitchTrackingRegistry()
        workflow_runs.generator_registry = registry
        background = BackgroundTasks()
        with self.assertRaises(HTTPException):
            asyncio.run(
                workflow_runs.create_run_from_image(
                    background,
                    image=_FakeUpload(),
                    model_id="sf3d",
                    collection="Default",
                    params='{"remesh": "garbage"}',
                )
            )
        self.assertFalse(registry.switched)


class CreateRunParamsTests(unittest.TestCase):
    """#384: params a model does not declare must not be accepted silently."""

    # Mirrors hunyuan3d-mini-turbo: texture_resolution is not part of its schema.
    _SCHEMA = [{"id": "octree_resolution"}, {"id": "seed"}]

    def setUp(self) -> None:
        self._previous = workflow_runs.generator_registry
        workflow_runs.generator_registry = _FakeRegistry(self._SCHEMA)

    def tearDown(self) -> None:
        workflow_runs.generator_registry = self._previous

    def _create(self, params: str) -> tuple[dict, BackgroundTasks]:
        background = BackgroundTasks()
        response = asyncio.run(
            workflow_runs.create_run_from_image(
                background,
                image=_FakeUpload(),
                model_id="hunyuan3d-mini-turbo",
                collection="Default",
                params=params,
            )
        )
        return response, background

    def test_undeclared_params_are_reported_in_the_response(self) -> None:
        response, _ = self._create(
            '{"remesh":"quad","enable_texture":true,"texture_resolution":2048,"octree_resolution":256}'
        )
        self.assertEqual(
            response["undeclared_params"], ["remesh", "enable_texture", "texture_resolution"]
        )

    def test_declared_params_are_not_reported(self) -> None:
        response, _ = self._create('{"octree_resolution": 256, "seed": 7}')
        self.assertEqual(response["undeclared_params"], [])

    def test_undeclared_params_are_still_forwarded_to_the_generator(self) -> None:
        # A schema is UI metadata, not an exhaustive contract: hunyuan reads enable_texture
        # without declaring it, so dropping or rejecting undeclared keys would break it.
        _, background = self._create('{"enable_texture": true, "texture_resolution": 2048}')
        forwarded = background.tasks[0].args[2]
        self.assertTrue(forwarded["enable_texture"])
        self.assertEqual(forwarded["texture_resolution"], 2048)

    def test_invalid_params_json_is_rejected(self) -> None:
        # Previously parsed as {} so every param was dropped without a word.
        with self.assertRaises(HTTPException) as ctx:
            self._create("{'texture_resolution': 2048}")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("params", str(ctx.exception.detail))

    def test_non_object_params_json_is_rejected(self) -> None:
        with self.assertRaises(HTTPException) as ctx:
            self._create('[["texture_resolution", 2048]]')
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
