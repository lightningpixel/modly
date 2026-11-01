import asyncio
import json
import unittest
from unittest import mock

import httpx

import routers.agent as agent


class _MockClientFactory:
    """Builds real AsyncClients wired to a MockTransport, so execute_tool talks to
    a fake Modly API instead of the network."""

    def __init__(self, handler) -> None:
        self._handler = handler
        self._real = httpx.AsyncClient

    def __call__(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(self._handler)
        return self._real(*args, **kwargs)


def _run_tool(name: str, handler) -> tuple[str, object]:
    factory = _MockClientFactory(handler)
    with mock.patch.object(agent.httpx, "AsyncClient", factory):
        return asyncio.run(agent.execute_tool(name, {}, {}))


class UnloadModelsErrorTests(unittest.TestCase):
    """unload_models must report a failed unload, not claim success (like every
    other POST tool and like the MCP server's modly_unload_models)."""

    def test_http_error_is_surfaced(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="boom")

        text, payload = _run_tool("unload_models", handler)
        # Before the fix the response was discarded and the success string was
        # returned even on a 500; now the shared HTTPStatusError handler runs.
        self.assertTrue(text.startswith("API error 500"), text)
        self.assertIsNone(payload)

    def test_success_still_reports_unloaded(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"ok": True})

        text, payload = _run_tool("unload_models", handler)
        self.assertIn("unloaded", text.lower())
        self.assertIsNone(payload)


class InspectMeshToolTests(unittest.TestCase):
    REPORT = {
        "printable": False,
        "face_count": 11,
        "vertex_count": 8,
        "component_count": 1,
        "is_watertight": False,
        "is_manifold": True,
        "is_winding_consistent": True,
        "hole_count": 1,
        "boundary_edge_count": 3,
        "non_manifold_edge_count": 0,
        "degenerate_face_count": 0,
        "self_intersecting_face_count": None,
        "dimensions": [1.0, 2.0, 0.5],
        "surface_area": 5.5,
        "volume": None,
        "has_uvs": False,
        "has_normals": True,
        "issues": ["1 hole(s) (3 open boundary edges)"],
    }

    def _run(self, name: str, response: dict) -> tuple[str, list]:
        requests = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json=response)

        factory = _MockClientFactory(handler)
        with mock.patch.object(agent.httpx, "AsyncClient", factory):
            text, payload = asyncio.run(
                agent.execute_tool(name, {"path": "Default/mesh.glb"}, {})
            )
        self.assertIsNone(payload)
        return text, requests

    def test_inspect_mesh_calls_the_registry_op_and_summarises(self) -> None:
        text, requests = self._run("inspect_mesh", self.REPORT)

        self.assertEqual(requests[0].url.path, "/optimize/op/inspect_mesh")
        self.assertIn("Printable: no", text)
        self.assertIn("Watertight: no", text)
        self.assertIn("Self-intersecting faces: not checked", text)
        self.assertIn("volume: n/a", text)
        self.assertIn("Issues: 1 hole(s)", text)

    def test_suggest_fixes_lists_ops_and_notes(self) -> None:
        text, requests = self._run(
            "suggest_fixes",
            {
                "report": self.REPORT,
                "fixes": [
                    {"op": "repair", "params": {"fill_holes": True}, "reason": "Repair to fill 1 hole(s)."}
                ],
                "notes": ["2 disconnected parts"],
            },
        )

        self.assertEqual(requests[0].url.path, "/optimize/op/suggest_fixes")
        self.assertIn('- repair {"fill_holes": true}', text)
        self.assertIn("Note: 2 disconnected parts", text)

    def test_suggest_fixes_on_a_clean_mesh(self) -> None:
        text, _ = self._run("suggest_fixes", {"report": {}, "fixes": [], "notes": []})

        self.assertIn("No fixes needed", text)


class RepairMeshToolTests(unittest.TestCase):
    def _run(self, arguments: dict, response: dict) -> tuple[str, object, list]:
        requests = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json=response)

        factory = _MockClientFactory(handler)
        with mock.patch.object(agent.httpx, "AsyncClient", factory):
            text, payload = asyncio.run(agent.execute_tool("repair_mesh", arguments, {}))
        return text, payload, requests

    def test_repaired_mesh_updates_the_viewer_and_warns_about_textures(self) -> None:
        text, payload, requests = self._run(
            {"path": "Default/mesh.glb"},
            {
                "path": "Workflows/repair-mesh-1.glb",
                "url": "/workspace/Workflows/repair-mesh-1.glb",
                "repaired": True,
                "passes": 2,
                "steps": ["fix_non_manifold", "fill_holes"],
                "remaining_issues": [],
                "face_count": 1276,
                "textures_dropped": True,
            },
        )

        self.assertEqual(requests[0].url.path, "/optimize/op/repair_mesh")
        self.assertEqual(json.loads(requests[0].content), {"path": "Default/mesh.glb", "params": {}})
        self.assertIn("now closed (watertight) and manifold", text)
        self.assertIn("New mesh path: Workflows/repair-mesh-1.glb", text)
        self.assertIn("textures and UVs were dropped", text)
        self.assertEqual(payload["type"], "mesh_update")
        self.assertEqual(payload["url"], "/workspace/Workflows/repair-mesh-1.glb")

    def test_partial_repair_reports_what_remains(self) -> None:
        text, _, requests = self._run(
            {"path": "Default/mesh.glb", "fill_holes": False},
            {
                "path": "Workflows/repair-mesh-2.glb",
                "url": "/workspace/Workflows/repair-mesh-2.glb",
                "repaired": True,
                "passes": 3,
                "steps": ["fix_non_manifold"],
                "remaining_issues": ["1 hole(s) (6 open boundary edges)"],
                "face_count": 100,
                "textures_dropped": False,
            },
        )

        self.assertEqual(json.loads(requests[0].content)["params"], {"fill_holes": False})
        self.assertIn("Still remaining: 1 hole(s)", text)
        self.assertNotIn("textures", text)

    def test_sound_mesh_changes_nothing(self) -> None:
        text, payload, _ = self._run(
            {"path": "Default/mesh.glb"},
            {"repaired": False, "passes": 0, "steps": [], "remaining_issues": []},
        )

        self.assertIn("Nothing to repair", text)
        self.assertIsNone(payload)


class ArrangeMeshToolTests(unittest.TestCase):
    def _run(self, arguments: dict) -> tuple[str, object, list]:
        requests = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json={
                "path": "Default/mesh_xf_1234abcd.glb",
                "url": "/workspace/Default/mesh_xf_1234abcd.glb",
                "applied": ["auto_orient", "recenter", "drop_to_ground"],
                "dimensions": [0.2, 0.05, 0.1],
            })

        factory = _MockClientFactory(handler)
        with mock.patch.object(agent.httpx, "AsyncClient", factory):
            text, payload = asyncio.run(agent.execute_tool("arrange_mesh", arguments, {}))
        return text, payload, requests

    def test_all_steps_go_in_one_request_and_the_new_path_is_reported(self) -> None:
        text, payload, requests = self._run({
            "path": "Default/mesh.glb",
            "steps": ["drop_to_ground", "recenter", "auto_orient"],
        })

        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0].url.path, "/optimize/arrange")
        self.assertEqual(json.loads(requests[0].content), {
            "path": "Default/mesh.glb",
            "steps": ["drop_to_ground", "recenter", "auto_orient"],
            "params": {},
        })
        # The path lets the model chain another tool on the result.
        self.assertIn("New mesh path: Default/mesh_xf_1234abcd.glb", text)
        self.assertEqual(payload, {"type": "mesh_update", "url": "/workspace/Default/mesh_xf_1234abcd.glb"})

    def test_scale_arguments_become_normalize_scale_params(self) -> None:
        _, _, requests = self._run({
            "path": "Default/mesh.glb",
            "steps": ["normalize_scale"],
            "size": 20,
            "unit": "cm",
        })

        self.assertEqual(
            json.loads(requests[0].content)["params"],
            {"normalize_scale": {"size": 20, "unit": "cm"}},
        )


if __name__ == "__main__":
    unittest.main()
