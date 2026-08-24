import asyncio
import unittest

import services.generator_registry as registry_module
from routers.extensions import reload_extensions


class _FakeRegistry:
    def __init__(self) -> None:
        self._generators = {"healthy/generate": object()}
        self.reload_calls: list[object] = []

    def reload(self, validation_capability: object = None) -> None:
        self.reload_calls.append(validation_capability)

    def load_errors(self) -> dict[str, str]:
        return {"pending/generate": "quarantined"}


class ExtensionReloadRouteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_registry = registry_module.generator_registry
        self.registry = _FakeRegistry()
        registry_module.generator_registry = self.registry

    def tearDown(self) -> None:
        registry_module.generator_registry = self.previous_registry

    def test_predictable_extension_id_is_ignored_and_response_shape_is_stable(self) -> None:
        response = asyncio.run(reload_extensions({
            "validatingExtensionId": "pending",
        }))

        self.assertEqual(self.registry.reload_calls, [None])
        self.assertEqual(
            response,
            {
                "reloaded": True,
                "models": ["healthy/generate"],
                "errors": {"pending/generate": "quarantined"},
            },
        )

    def test_only_nested_validation_capability_is_forwarded(self) -> None:
        capability = {
            "extensionId": "pending",
            "destinationName": "pending",
            "stateName": ".modly-registration-pending-pending-100",
            "token": "t" * 43,
        }

        asyncio.run(reload_extensions({
            "validationCapability": capability,
        }))

        self.assertEqual(self.registry.reload_calls, [capability])


if __name__ == "__main__":
    unittest.main()
