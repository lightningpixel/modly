import asyncio
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

import routers.model as model_router
import services.generator_registry as registry


SOURCES = [
    {
        "id": "primary",
        "provider": "huggingface",
        "repo_id": "org/main",
        "destination": ".",
        "checks": ["main.bin"],
    },
    {
        "id": "encoder",
        "provider": "huggingface",
        "repo_id": "org/encoder",
        "destination": "auxiliary/encoder",
        "checks": ["encoder.bin"],
    },
]


def request_for(sources: list[dict]) -> Request:
    body = json.dumps({"sources": sources}).encode()
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": body, "more_body": False}

    return Request({
        "type": "http",
        "method": "POST",
        "path": "/model/hf-download-sources",
        "headers": [(b"authorization", b"Bearer test-token")],
        "query_string": b"",
        "server": ("test", 80),
        "client": ("test", 1),
        "scheme": "http",
    }, receive)


async def collect_events(response) -> list[dict]:
    payload = ""
    async for chunk in response.body_iterator:
        payload += chunk.decode() if isinstance(chunk, bytes) else chunk
    return [
        json.loads(block[6:])
        for block in payload.strip().split("\n\n")
        if block.startswith("data: ")
    ]


class MultiSourceRouterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="modly-model-router-")
        self.models_dir = Path(self.tempdir.name) / "models"
        self.models_dir.mkdir()
        self.old_models_dir = registry.MODELS_DIR
        registry.MODELS_DIR = self.models_dir
        # Keep the test hermetic against an import-time copy of the path: if the
        # router still holds its own MODELS_DIR name, point that copy at the same
        # temp tree so a stale read fails the assertions below instead of
        # writing into the real models folder.
        self.had_stale_models_dir = hasattr(model_router, "MODELS_DIR")
        if self.had_stale_models_dir:
            self.old_stale_models_dir = model_router.MODELS_DIR
            model_router.MODELS_DIR = self.models_dir
        self.old_hf_module = sys.modules.get("huggingface_hub")

    def tearDown(self) -> None:
        registry.MODELS_DIR = self.old_models_dir
        if self.had_stale_models_dir:
            model_router.MODELS_DIR = self.old_stale_models_dir
        model_router._download_controls.clear()
        if self.old_hf_module is None:
            sys.modules.pop("huggingface_hub", None)
        else:
            sys.modules["huggingface_hub"] = self.old_hf_module
        self.tempdir.cleanup()

    def install_hf_stub(self, files: dict[str, list[str]], calls: list[str]) -> None:
        module = types.ModuleType("huggingface_hub")

        def list_repo_files(repo_id, revision=None, token=None):
            calls.append(f"list:{repo_id}:{revision}:{token}")
            return files[repo_id]

        def hf_hub_url(repo_id, filename, revision=None):
            return f"https://example.invalid/{repo_id}/{revision or 'main'}/{filename}"

        module.list_repo_files = list_repo_files
        module.hf_hub_url = hf_hub_url
        sys.modules["huggingface_hub"] = module

    def test_lists_every_source_before_sequential_download_with_monotonic_progress(self) -> None:
        calls: list[str] = []
        controls: list[int] = []
        self.install_hf_stub({"org/main": ["main.bin"], "org/encoder": ["encoder.bin"]}, calls)

        def fake_download(**kwargs):
            calls.append(f"download:{kwargs['dest_dir']}:{kwargs['filename']}")
            controls.append(id(kwargs["control"]))
            target = Path(kwargs["dest_dir"]) / kwargs["filename"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"data")
            kwargs["progress_cb"]({
                "percent": kwargs["base_percent"],
                "file": kwargs["filename"],
                "fileIndex": kwargs["file_index"],
                "totalFiles": kwargs["total_files"],
                "status": "Downloading...",
                "bytesDownloaded": 4,
                "stalledSeconds": 0,
            })
            return 4

        async def run():
            with patch.object(model_router, "_download_file_streamed", fake_download):
                response = await model_router.hf_download_sources(
                    request_for(SOURCES), "pixal3d/generate"
                )
                return await collect_events(response)

        events = asyncio.run(run())
        first_download = next(index for index, value in enumerate(calls) if value.startswith("download:"))
        self.assertTrue(all(value.startswith("list:") for value in calls[:first_download]))
        self.assertEqual(len(set(controls)), 1)
        self.assertEqual([event["percent"] for event in events if "percent" in event], sorted(
            event["percent"] for event in events if "percent" in event
        ))
        self.assertEqual(events[-1], {"percent": 100, "status": "done"})
        self.assertTrue((self.models_dir / "pixal3d/generate/main.bin").is_file())
        self.assertTrue((self.models_dir / "pixal3d/generate/auxiliary/encoder/encoder.bin").is_file())

    def test_pause_cancel_and_resume_reuse_one_model_control(self) -> None:
        calls: list[str] = []
        self.install_hf_stub({"org/main": ["main.bin"]}, calls)
        source = [SOURCES[0]]
        mode = "pause"

        def controlled_download(**kwargs):
            target = Path(kwargs["dest_dir"]) / kwargs["filename"]
            target.parent.mkdir(parents=True, exist_ok=True)
            part = Path(f"{target}.part")
            part.write_bytes(b"partial")
            if mode == "pause":
                kwargs["control"]["pause"].set()
                model_router._check_download_control(kwargs["control"])
            if mode == "cancel":
                kwargs["control"]["cancel"].set()
                model_router._check_download_control(kwargs["control"])
            part.replace(target)
            return target.stat().st_size

        async def one_run():
            with patch.object(model_router, "_download_file_streamed", controlled_download):
                response = await model_router.hf_download_sources(
                    request_for(source), "pixal3d/generate"
                )
                return await collect_events(response)

        paused = asyncio.run(one_run())
        self.assertTrue(paused[-1]["paused"])
        self.assertTrue((self.models_dir / "pixal3d/generate/main.bin.part").is_file())

        mode = "cancel"
        cancelled = asyncio.run(one_run())
        self.assertTrue(cancelled[-1]["cancelled"])
        self.assertFalse((self.models_dir / "pixal3d/generate/main.bin.part").exists())

        mode = "resume"
        resumed = asyncio.run(one_run())
        self.assertEqual(resumed[-1], {"percent": 100, "status": "done"})
        self.assertTrue((self.models_dir / "pixal3d/generate/main.bin").is_file())

    def test_rejects_a_check_filtered_out_of_the_source_plan(self) -> None:
        calls: list[str] = []
        self.install_hf_stub({"org/main": ["other.bin"]}, calls)

        async def run():
            response = await model_router.hf_download_sources(
                request_for([SOURCES[0]]), "pixal3d/generate"
            )
            return await collect_events(response)

        events = asyncio.run(run())
        self.assertIn("excluded from its download plan", events[-1]["error"])
        self.assertFalse((self.models_dir / "pixal3d/generate/other.bin").exists())

    def move_models_folder(self) -> Path:
        # What POST /settings/paths does through GeneratorRegistry.update_paths():
        # rebind the registry's MODELS_DIR while the API keeps running.
        moved = Path(self.tempdir.name) / "moved-models"
        moved.mkdir()
        registry.MODELS_DIR = moved
        return moved

    def test_multi_source_download_follows_a_moved_models_folder(self) -> None:
        calls: list[str] = []
        self.install_hf_stub({"org/main": ["main.bin"]}, calls)
        moved = self.move_models_folder()

        def fake_download(**kwargs):
            target = Path(kwargs["dest_dir"]) / kwargs["filename"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"data")
            return 4

        async def run():
            with patch.object(model_router, "_download_file_streamed", fake_download):
                response = await model_router.hf_download_sources(
                    request_for([SOURCES[0]]), "pixal3d/generate"
                )
                return await collect_events(response)

        events = asyncio.run(run())
        # Reported as a success whichever folder it lands in -- which is why the
        # stale path went unnoticed.
        self.assertEqual(events[-1], {"percent": 100, "status": "done"})
        self.assertTrue((moved / "pixal3d/generate/main.bin").is_file())
        self.assertFalse((self.models_dir / "pixal3d/generate/main.bin").exists())

    def test_single_repo_download_follows_a_moved_models_folder(self) -> None:
        calls: list[str] = []
        self.install_hf_stub({"org/main": ["main.bin"]}, calls)
        moved = self.move_models_folder()
        destinations: list[str] = []

        def fake_download(**kwargs):
            destinations.append(kwargs["dest_dir"])
            return 4

        async def run():
            with patch.object(model_router, "_download_file_streamed", fake_download):
                response = await model_router.hf_download(
                    repo_id="org/main",
                    model_id="sf3d",
                    skip_prefixes="[]",
                    include_prefixes="[]",
                )
                return await collect_events(response)

        events = asyncio.run(run())
        self.assertEqual(events[-1], {"percent": 100, "status": "done"})
        self.assertEqual(destinations, [str(moved / "sf3d")])

    def test_moved_models_folder_still_refuses_a_non_node_model_id(self) -> None:
        self.move_models_folder()
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(model_router.hf_download_sources(request_for([SOURCES[0]]), "pixal3d"))
        self.assertEqual(raised.exception.status_code, 400)

    def test_composite_model_unload_route_uses_path_converter(self) -> None:
        paths = {route.path for route in model_router.router.routes}
        self.assertIn("/unload/{model_id:path}", paths)
        self.assertEqual(model_router.Request.__module__, "urllib.request")


if __name__ == "__main__":
    unittest.main()
