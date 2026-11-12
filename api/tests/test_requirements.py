import re
import unittest
from pathlib import Path


REQUIREMENTS = Path(__file__).resolve().parents[1] / "requirements.txt"


def declared_packages() -> set[str]:
    names = set()
    for line in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            names.add(re.split(r"[\[<>=!~ ;]", line, maxsplit=1)[0].lower())
    return names


class RequirementsTest(unittest.TestCase):
    def test_pillow_is_declared(self) -> None:
        # Without Pillow, trimesh cannot decode glTF images and silently drops
        # every texture when an op reloads and re-exports a mesh.
        self.assertIn("pillow", declared_packages())


if __name__ == "__main__":
    unittest.main()
