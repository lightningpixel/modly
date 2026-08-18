import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from evals.grader import grade


class GraderTests(unittest.TestCase):
    def test_passes_when_expected_tool_called_cleanly(self):
        case = {"expect": {"tools_include": ["create_workflow"], "no_param_error": True}}
        actions = [{"tool": "create_workflow", "result": "Created workflow 'x' with 2 step(s)."}]
        ok, reasons = grade(case, actions, "done", None)
        self.assertTrue(ok, reasons)

    def test_missing_expected_tool_fails(self):
        case = {"expect": {"tools_include": ["run_workflow"]}}
        ok, reasons = grade(case, [], "", None)
        self.assertFalse(ok)
        self.assertTrue(any("run_workflow" in r for r in reasons))

    def test_excluded_tool_fails(self):
        case = {"expect": {"tools_exclude": ["update_workflow"]}}
        actions = [{"tool": "update_workflow", "result": "ok"}]
        ok, reasons = grade(case, actions, "", None)
        self.assertFalse(ok)

    def test_param_error_marker_fails(self):
        case = {"expect": {"tools_include": ["create_workflow"], "no_param_error": True}}
        actions = [{"tool": "create_workflow", "result": "Unknown param id(s) pixels for image-to-3d."}]
        ok, reasons = grade(case, actions, "", None)
        self.assertFalse(ok)
        self.assertTrue(any("param error" in r for r in reasons))

    def test_stream_error_fails_unless_allowed(self):
        self.assertFalse(grade({"expect": {}}, [], "", "boom")[0])
        self.assertTrue(grade({"expect": {"allow_error": True}}, [], "", "boom")[0])

    def test_no_tools_expectation(self):
        self.assertTrue(grade({"expect": {"no_tools": True}}, [], "I need a clarification.", None)[0])
        self.assertFalse(grade({"expect": {"no_tools": True}}, [{"tool": "run_workflow"}], "", None)[0])

    def test_final_includes_substring(self):
        case = {"expect": {"final_includes": ["cannot"]}}
        self.assertTrue(grade(case, [], "Sorry, I cannot generate video.", None)[0])
        self.assertFalse(grade(case, [], "Done!", None)[0])

    def test_payload_includes_matches_nested_subset(self):
        case = {"expect": {"payload_includes": [
            {"type": "update_workflow", "set_params": [{"step": 1, "params": {"resolution": 2048}}]},
        ]}}
        actions = [{"tool": "set_param", "result": "ok", "payload": {
            "type": "update_workflow",
            "workflow_id": "wf-1",
            "set_params": [{"step": 1, "params": {"resolution": 2048, "steps": 30}}],
        }}]
        ok, reasons = grade(case, actions, "", None)
        self.assertTrue(ok, reasons)

    def test_payload_includes_catches_valid_but_wrong_param(self):
        # The failure mode constrained decoding introduces: a param id that is
        # valid (so no error is raised) but not the one the user asked for.
        case = {"expect": {"no_param_error": True, "payload_includes": [
            {"set_params": [{"params": {"resolution": 2048}}]},
        ]}}
        actions = [{"tool": "set_param", "result": "ok", "payload": {
            "type": "update_workflow",
            "set_params": [{"step": 1, "params": {"quality": 2048}}],
        }}]
        ok, reasons = grade(case, actions, "", None)
        self.assertFalse(ok)
        self.assertTrue(any("no action payload matched" in r for r in reasons))

    def test_payload_includes_ignores_actions_without_payload(self):
        case = {"expect": {"payload_includes": [{"type": "run_workflow"}]}}
        actions = [{"tool": "list_workflows", "result": "…", "payload": None}]
        self.assertFalse(grade(case, actions, "", None)[0])

    def test_payload_excludes_catches_the_wrong_extension_alongside_the_right_one(self):
        # A disambiguation case: picking the right step AND the two wrong ones is
        # not a pass, even though payload_includes alone would say it is.
        case = {"expect": {
            "payload_includes": [{"workflow": {"nodes": [{"data": {"extensionId": "pymeshlab/pymeshlab"}}]}}],
            "payload_excludes": [{"workflow": {"nodes": [{"data": {"extensionId": "lowpoly/lowpoly"}}]}}],
        }}
        both = [{"tool": "create_workflow", "result": "ok", "payload": {
            "type": "create_workflow",
            "workflow": {"nodes": [
                {"data": {"extensionId": "pymeshlab/pymeshlab"}},
                {"data": {"extensionId": "lowpoly/lowpoly"}},
            ]},
        }}]
        ok, reasons = grade(case, both, "", None)
        self.assertFalse(ok)
        self.assertTrue(any("payload contained" in r for r in reasons))

        right_only = [{"tool": "create_workflow", "result": "ok", "payload": {
            "type": "create_workflow",
            "workflow": {"nodes": [{"data": {"extensionId": "pymeshlab/pymeshlab"}}]},
        }}]
        self.assertTrue(grade(case, right_only, "", None)[0])

    def test_payloads_exclude_allows_a_rejected_attempt(self):
        # Calling create_workflow and being told the chain can't be built is fine;
        # only an emitted payload would have created something.
        case = {"expect": {"payloads_exclude": ["create_workflow"]}}
        rejected = [{"tool": "create_workflow", "result": "No installed extension turns image into mesh.", "payload": None}]
        self.assertTrue(grade(case, rejected, "", None)[0])

        created = [{"tool": "create_workflow", "result": "ok", "payload": {"type": "create_workflow", "workflow": {}}}]
        ok, reasons = grade(case, created, "", None)
        self.assertFalse(ok)
        self.assertTrue(any("unexpected create_workflow payload" in r for r in reasons))


if __name__ == "__main__":
    unittest.main()
