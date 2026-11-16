import asyncio
import json
import unittest
from unittest import mock

import httpx

import routers.agent as agent
from services.mesh_ops import AgentTool, MeshOp, MeshOpResult, MeshOpsRegistry, mesh_ops_registry


def _noop(path, params, context) -> MeshOpResult:
    return MeshOpResult()


_THICKEN = MeshOp(
    id="thicken",
    label="Thicken Walls",
    params_schema=(
        {"id": "thickness", "label": "Thickness", "type": "float", "default": 2.0, "min": 0.5, "max": 10.0},
        {"id": "unit", "label": "Unit", "type": "select", "default": "mm",
         "options": [{"value": "mm", "label": "mm"}, {"value": "cm", "label": "cm"}]},
        {"id": "hollow", "label": "Hollow", "type": "boolean", "default": False},
        {"id": "passes", "label": "Passes", "type": "int", "default": 1, "min": 1, "max": 5},
    ),
    fn=_noop,
    category="repair",
    agent=AgentTool(
        description="Thicken thin walls so the mesh can be printed.",
        params={"thickness": "Wall thickness.", "unit": "Unit of `thickness`.", "hollow": "Keep it hollow."},
        required=("thickness",),
    ),
)

_HIDDEN = MeshOp(id="hidden", label="Hidden", params_schema=(), fn=_noop, category="repair")


def _tool(tools: list[dict], name: str) -> dict:
    return next(t["function"] for t in tools if t["function"]["name"] == name)


def _names(tools: list[dict]) -> set[str]:
    return {t["function"]["name"] for t in tools}


class RegistryToolSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.registry = MeshOpsRegistry([_THICKEN, _HIDDEN])

    def test_an_exposed_op_becomes_a_tool_without_touching_agent(self) -> None:
        fn = _tool(agent.registry_tools(self.registry), "thicken")

        self.assertEqual(fn["description"], "Thicken thin walls so the mesh can be printed.")
        props = fn["parameters"]["properties"]
        self.assertEqual(props["path"]["type"], "string")
        self.assertEqual(props["thickness"]["type"], "number")
        self.assertIn("0.5", props["thickness"]["description"])
        self.assertIn("10", props["thickness"]["description"])
        self.assertIn("default 2", props["thickness"]["description"])
        self.assertEqual(props["unit"]["type"], "string")
        self.assertEqual(props["unit"]["enum"], ["mm", "cm"])
        self.assertEqual(props["hollow"]["type"], "boolean")
        self.assertEqual(fn["parameters"]["required"], ["path", "thickness"])

    def test_params_without_an_agent_description_stay_hidden(self) -> None:
        props = _tool(agent.registry_tools(self.registry), "thicken")["parameters"]["properties"]

        self.assertNotIn("passes", props)

    def test_int_params_map_to_integer(self) -> None:
        op = MeshOp(
            id="count", label="Count", fn=_noop, category="x",
            params_schema=({"id": "n", "type": "int", "default": 3},),
            agent=AgentTool(description="Count.", params={"n": "How many."}),
        )

        props = _tool(agent.registry_tools(MeshOpsRegistry([op])), "count")["parameters"]["properties"]

        self.assertEqual(props["n"]["type"], "integer")

    def test_ops_without_an_agent_spec_are_not_tools(self) -> None:
        self.assertNotIn("hidden", _names(agent.registry_tools(self.registry)))

    def test_system_prompt_lists_exposed_ops(self) -> None:
        lines = agent.registry_tool_lines(self.registry)

        self.assertIn("thicken(path, thickness, unit?, hollow?)", lines)
        self.assertIn("Thicken thin walls", lines)
        self.assertNotIn("hidden", lines)


class BuiltinExposureTests(unittest.TestCase):
    def test_the_chat_exposes_the_curated_builtin_ops(self) -> None:
        names = _names(agent.TOOLS)

        for op_id in ("inspect_mesh", "suggest_fixes", "repair_mesh", "decimate", "smooth"):
            self.assertIn(op_id, names)
        for op_id in ("repair", "recenter", "drop_to_ground", "auto_orient", "normalize_scale"):
            self.assertNotIn(op_id, names)
        # Renamed to their registry ids; arrange_mesh stays a hand-written tool.
        self.assertNotIn("decimate_mesh", names)
        self.assertNotIn("smooth_mesh", names)
        self.assertIn("arrange_mesh", names)

    def test_every_tool_name_is_unique(self) -> None:
        names = [t["function"]["name"] for t in agent.TOOLS]
        self.assertEqual(len(names), len(set(names)))

    def test_system_prompt_lists_registry_tools(self) -> None:
        self.assertIn("**decimate(path, target_faces)**", agent.SYSTEM_PROMPT)
        self.assertIn("**smooth(path, iterations)**", agent.SYSTEM_PROMPT)
        self.assertNotIn("decimate_mesh", agent.SYSTEM_PROMPT)


class RegistryToolExecutionTests(unittest.TestCase):
    def _run(self, name: str, arguments: dict, response: dict, registry=None) -> tuple[str, object, list]:
        requests = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(200, json=response)

        real = httpx.AsyncClient

        def factory(*args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            return real(*args, **kwargs)

        with mock.patch.object(agent.httpx, "AsyncClient", factory), \
                mock.patch.object(agent, "mesh_ops_registry", registry or mesh_ops_registry):
            text, payload = asyncio.run(agent.execute_tool(name, arguments, {}))
        return text, payload, requests

    def test_a_new_op_runs_through_the_generic_endpoint(self) -> None:
        text, payload, requests = self._run(
            "thicken",
            {"path": "Default/mesh.glb", "thickness": 3, "passes": 4},
            {"path": "Default/mesh_thicken.glb", "url": "/workspace/Default/mesh_thicken.glb", "face_count": 1200},
            registry=MeshOpsRegistry([_THICKEN]),
        )

        self.assertEqual(requests[0].url.path, "/optimize/op/thicken")
        # Only the params exposed to the agent are forwarded.
        self.assertEqual(json.loads(requests[0].content), {"path": "Default/mesh.glb", "params": {"thickness": 3}})
        self.assertIn("Thicken Walls", text)
        self.assertIn("Default/mesh_thicken.glb", text)
        self.assertIn("1,200 faces", text)
        self.assertEqual(payload, {"type": "mesh_update", "url": "/workspace/Default/mesh_thicken.glb", "face_count": 1200})

    def test_decimate_uses_the_registry_op(self) -> None:
        text, payload, requests = self._run(
            "decimate",
            {"path": "Default/mesh.glb", "target_faces": 5000},
            {"path": "Default/mesh_decimate.glb", "url": "/workspace/Default/mesh_decimate.glb", "face_count": 5000},
        )

        self.assertEqual(requests[0].url.path, "/optimize/op/decimate")
        self.assertEqual(json.loads(requests[0].content)["params"], {"target_faces": 5000})
        self.assertIn("5,000 faces", text)
        self.assertEqual(payload["type"], "mesh_update")
        self.assertEqual(payload["face_count"], 5000)

    def test_an_op_without_output_file_updates_nothing(self) -> None:
        text, payload, _ = self._run(
            "thicken",
            {"path": "Default/mesh.glb", "thickness": 1},
            {"walls_ok": True},
            registry=MeshOpsRegistry([_THICKEN]),
        )

        self.assertIsNone(payload)
        self.assertIn("walls_ok", text)

    def test_unexposed_ops_are_not_callable(self) -> None:
        text, payload, requests = self._run("recenter", {"path": "Default/mesh.glb"}, {})

        self.assertEqual(text, "Unknown tool: recenter")
        self.assertIsNone(payload)
        self.assertEqual(requests, [])


if __name__ == "__main__":
    unittest.main()
