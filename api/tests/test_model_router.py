import asyncio
import json
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from starlette.requests import Request

import routers.model as model_router


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
        self.old_models_dir = model_router.registry_module.MODELS_DIR
        model_router.registry_module.MODELS_DIR = self.models_dir
        self.old_hf_module = sys.modules.get("huggingface_hub")

    def tearDown(self) -> None:
        model_router.registry_module.MODELS_DIR = self.old_models_dir
        model_router._download_controls.clear()
        if self.old_hf_module is None:
            sys.modules.pop("huggingface_hub", None)
        else:
            sys.modules["huggingface_hub"] = self.old_hf_module
        self.tempdir.cleanup()

    def install_hf_stub(self, files: dict[str, list[str]], calls: list[str]) -> None:
        module = types.ModuleType("huggingface_hub")

        class HfApi:
            def list_repo_tree(self, repo_id, revision=None, token=None, recursive=False):
                calls.append(f"list:{repo_id}:{revision}:{token}")
                return [types.SimpleNamespace(path=name, size=None) for name in files[repo_id]]

        def hf_hub_url(repo_id, filename, revision=None):
            return f"https://example.invalid/{repo_id}/{revision or 'main'}/{filename}"

        module.HfApi = HfApi
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

    def test_shared_target_downloads_under_extension_reserved_root(self) -> None:
        calls: list[str] = []
        self.install_hf_stub({"org/main": ["main.bin"]}, calls)

        def fake_download(**kwargs):
            target = Path(kwargs["dest_dir"]) / kwargs["filename"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"shared")
            return target.stat().st_size

        async def run():
            with patch.object(model_router, "_download_file_streamed", fake_download):
                response = await model_router.hf_download_sources(
                    request_for([SOURCES[0]]), "pixal3d/_shared/base"
                )
                return await collect_events(response)

        events = asyncio.run(run())
        self.assertEqual(events[-1], {"percent": 100, "status": "done"})
        self.assertTrue(
            (self.models_dir / "pixal3d/_shared/base/main.bin").is_file()
        )

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

    def test_download_uses_live_storage_after_settings_update(self):
        calls = []
        self.install_hf_stub({"org/main": ["main.bin"]}, calls)
        relocated = self.models_dir.parent / "relocated"
        registry = model_router.registry_module.GeneratorRegistry()
        registry.update_paths(relocated, None)

        def fake_download(**kwargs):
            target = Path(kwargs["dest_dir"]) / kwargs["filename"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b"complete")
            return target.stat().st_size

        async def run():
            with patch.object(model_router, "_download_file_streamed", fake_download):
                for target_id in ("pixal3d/generate", "pixal3d/_shared/base"):
                    response = await model_router.hf_download_sources(request_for([SOURCES[0]]), target_id)
                    await collect_events(response)
                    self.assertTrue((relocated / target_id / "main.bin").is_file())
                    self.assertFalse((self.models_dir / target_id).exists())
        asyncio.run(run())

    def test_removal_unload_requires_confirmed_process_stop(self):
        from unittest.mock import Mock
        from services.extension_process import ExtensionProcess
        gen = Mock(spec=ExtensionProcess)
        with patch.object(model_router.generator_registry, "get_generator", return_value=gen):
            self.assertEqual(asyncio.run(model_router.unload_model("demo/a")), {"unloaded": True})
            gen.stop.assert_called_once()
            gen.unload.assert_not_called()
            gen.stop.side_effect = RuntimeError("still running")
            with self.assertRaisesRegex(RuntimeError, "still running"):
                asyncio.run(model_router.unload_model("demo/a"))

    def test_removal_rejects_direct_generator_that_remains_loaded(self):
        from unittest.mock import Mock
        from fastapi import HTTPException
        gen = Mock()
        gen.is_loaded.return_value = True
        with patch.object(model_router.generator_registry, "get_generator", return_value=gen):
            with self.assertRaises(HTTPException) as error:
                asyncio.run(model_router.unload_model("demo/a"))
            self.assertEqual(error.exception.status_code, 409)

    def test_composite_model_unload_route_uses_path_converter(self) -> None:
        paths = {route.path for route in model_router.router.routes}
        self.assertIn("/unload/{model_id:path}", paths)
        self.assertEqual(model_router.Request.__module__, "urllib.request")


class ModelLifecycleEndpointTests(unittest.TestCase):
    def test_status_and_switch_do_not_block_the_event_loop_while_lifecycle_is_contended(self) -> None:
        class ContendedRegistry:
            def __init__(self):
                self.lock = threading.Lock()
            def active_status(self):
                with self.lock:
                    return {"id": "demo/a", "loaded": True}
            def switch_model(self, model_id):
                with self.lock:
                    return None

        registry = ContendedRegistry()
        previous = model_router.generator_registry
        model_router.generator_registry = registry

        async def assert_responsive(call):
            registry.lock.acquire()
            release = threading.Timer(0.25, registry.lock.release)
            release.start()
            try:
                start = asyncio.get_running_loop().time()
                task = asyncio.create_task(call())
                await asyncio.sleep(0.02)
                elapsed = asyncio.get_running_loop().time() - start
                self.assertLess(elapsed, 0.15)
                return await task
            finally:
                release.join()

        async def run():
            status = await assert_responsive(model_router.model_status)
            switched = await assert_responsive(lambda: model_router.switch_model("demo/b"))
            return status, switched

        try:
            status, switched = asyncio.run(run())
        finally:
            model_router.generator_registry = previous

        self.assertEqual(status["id"], "demo/a")
        self.assertEqual(switched, {"active": "demo/b"})


class _FakeResponse:
    """urlopen() stand-in serving ``body`` and, like http.client, returning b""
    at EOF even when Content-Length promised more."""

    def __init__(self, body: bytes, content_length: int, status: int = 200) -> None:
        self._body = body
        self.status = status
        self.headers = {"Content-Length": str(content_length)}

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> None:
        return None

    def read(self, size: int) -> bytes:
        chunk, self._body = self._body[:size], self._body[size:]
        return chunk


class DownloadFileStreamedTests(unittest.TestCase):
    FULL = b"0123456789"

    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="modly-download-")
        self.dest = Path(self.tempdir.name)
        self.control = {"pause": threading.Event(), "cancel": threading.Event()}
        self.requests: list[dict] = []
        patches = [
            patch.object(model_router.time, "sleep", lambda _s: None),
            patch.object(model_router, "_resolve_direct_download_url", lambda url, headers: url),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def download(self, responses: list, expected_size=None) -> int:
        def fake_urlopen(request, timeout=None):
            self.requests.append(dict(request.header_items()))
            return responses.pop(0)

        with patch.object(model_router, "urlopen", fake_urlopen):
            return model_router._download_file_streamed(
                url="https://example.invalid/w.safetensors",
                filename="w.safetensors",
                dest_dir=str(self.dest),
                file_index=1,
                total_files=1,
                base_percent=1,
                progress_cb=lambda _m: None,
                control=self.control,
                expected_size=expected_size,
            )

    def test_stream_closed_early_resumes_instead_of_saving_a_truncated_file(self) -> None:
        size = self.download([
            _FakeResponse(self.FULL[:4], content_length=len(self.FULL)),
            _FakeResponse(self.FULL[4:], content_length=6, status=206),
        ])

        self.assertEqual(size, len(self.FULL))
        self.assertEqual((self.dest / "w.safetensors").read_bytes(), self.FULL)
        self.assertEqual(self.requests[1].get("Range"), "bytes=4-")
        self.assertFalse((self.dest / "w.safetensors.part").exists())

    def test_never_renames_a_short_file_into_place(self) -> None:
        responses = [_FakeResponse(self.FULL[:4], content_length=len(self.FULL))]
        responses += [_FakeResponse(b"", content_length=6, status=206) for _ in range(2)]
        with self.assertRaisesRegex(RuntimeError, "received 4 of 10 bytes"):
            self.download(responses)

        self.assertFalse((self.dest / "w.safetensors").exists())
        self.assertEqual((self.dest / "w.safetensors.part").read_bytes(), self.FULL[:4])

    def test_existing_file_with_the_wrong_size_is_downloaded_again(self) -> None:
        (self.dest / "w.safetensors").write_bytes(self.FULL[:4])
        size = self.download(
            [_FakeResponse(self.FULL, content_length=len(self.FULL))],
            expected_size=len(self.FULL),
        )

        self.assertEqual(size, len(self.FULL))
        self.assertEqual((self.dest / "w.safetensors").read_bytes(), self.FULL)

    def test_existing_file_with_the_expected_size_is_kept(self) -> None:
        (self.dest / "w.safetensors").write_bytes(self.FULL)
        self.assertEqual(self.download([], expected_size=len(self.FULL)), len(self.FULL))
        self.assertEqual(self.requests, [])

    def test_repo_listing_reports_file_sizes_and_skips_folders(self) -> None:
        module = types.ModuleType("huggingface_hub")
        seen: dict = {}

        class HfApi:
            def list_repo_tree(self, repo_id, revision=None, token=None, recursive=False):
                seen.update(repo_id=repo_id, revision=revision, token=token, recursive=recursive)
                return [
                    types.SimpleNamespace(path="transformer", tree_id="t"),
                    types.SimpleNamespace(path="transformer/w.safetensors", size=10),
                ]

        module.HfApi = HfApi
        with patch.dict(sys.modules, {"huggingface_hub": module}):
            sizes = model_router._list_repo_file_sizes("org/repo", "main", "tok")

        self.assertEqual(sizes, {"transformer/w.safetensors": 10})
        self.assertEqual(
            seen, {"repo_id": "org/repo", "revision": "main", "token": "tok", "recursive": True}
        )


if __name__ == "__main__":
    unittest.main()
