import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from services.image_ops import ImageOpContext, ImageOpInputError, image_ops_registry
from services.image_ops import framing


def _open(path) -> Image.Image:
    with Image.open(path) as image:
        image.load()
        return image


def _visible_box(image: Image.Image) -> tuple[int, int, int, int]:
    return framing.subject_bbox(np.asarray(image.getchannel("A")))


class CropBoxTests(unittest.TestCase):
    def test_trims_each_edge_by_its_percentage(self) -> None:
        self.assertEqual(framing.crop_box(200, 100, 10, 20, 25, 0), (20, 20, 150, 100))

    def test_no_trim_keeps_the_whole_image(self) -> None:
        self.assertEqual(framing.crop_box(64, 32, 0, 0, 0, 0), (0, 0, 64, 32))

    def test_never_empty(self) -> None:
        self.assertEqual(framing.crop_box(1, 1, 45, 45, 45, 45), (0, 0, 1, 1))
        x0, y0, x1, y1 = framing.crop_box(3, 3, 60, 60, 60, 60)
        self.assertGreater(x1, x0)
        self.assertGreater(y1, y0)


class SubjectBoxTests(unittest.TestCase):
    def test_box_of_the_visible_pixels(self) -> None:
        alpha = np.zeros((10, 20), dtype=np.uint8)
        alpha[2:5, 3:9] = 255
        self.assertEqual(framing.subject_bbox(alpha), (3, 2, 9, 5))

    def test_faint_haze_is_ignored(self) -> None:
        alpha = np.full((10, 20), framing.SUBJECT_ALPHA_THRESHOLD, dtype=np.uint8)
        alpha[4, 4] = 200
        self.assertEqual(framing.subject_bbox(alpha), (4, 4, 5, 5))

    def test_none_when_fully_transparent(self) -> None:
        self.assertIsNone(framing.subject_bbox(np.zeros((4, 4), dtype=np.uint8)))


class FrameSquareTests(unittest.TestCase):
    def test_off_center_subject_is_centered_with_a_uniform_margin(self) -> None:
        image = Image.new("RGBA", (300, 200), (0, 0, 0, 0))
        image.paste((200, 30, 30, 255), (200, 20, 280, 60))  # 80x40, near the top-right corner
        framed = framing.frame_square(image, (200, 20, 280, 60), 100, 10)
        self.assertEqual((framed.mode, framed.size), ("RGBA", (100, 100)))
        # The longer side spans the square minus 10 px on each side; the other is centered.
        self.assertEqual(_visible_box(framed), (10, 30, 90, 70))

    def test_tall_subject_keeps_its_aspect_ratio(self) -> None:
        image = Image.new("RGBA", (50, 100), (0, 0, 0, 0))
        image.paste((0, 0, 255, 255), (0, 0, 25, 100))
        framed = framing.frame_square(image, (0, 0, 25, 100), 200, 0)
        self.assertEqual(_visible_box(framed), (75, 0, 125, 200))

    def test_transparent_edges_do_not_darken(self) -> None:
        image = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
        image.paste((255, 255, 255, 255), (10, 10, 30, 30))
        framed = framing.frame_square(image, (0, 0, 40, 40), 97, 0)
        rgba = np.asarray(framed)
        partly = (rgba[..., 3] >= 32) & (rgba[..., 3] < 255)
        self.assertTrue(partly.any())
        self.assertGreater(rgba[partly][:, :3].min(), 240)


class FramingOpsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.workspace = Path(self._tmp.name) / "workspace"
        self.workspace.mkdir()
        self.context = ImageOpContext(workspace_dir=self.workspace)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _save(self, image: Image.Image, name: str) -> Path:
        path = self.workspace / name
        image.save(path)
        return path

    def test_ops_need_no_download(self) -> None:
        for op_id in ("crop", "auto_frame"):
            with self.subTest(op=op_id):
                self.assertEqual(image_ops_registry.get(op_id).missing(), [])

    def test_crop_writes_a_new_image(self) -> None:
        pixels = np.arange(40 * 20 * 3, dtype=np.uint32).reshape(20, 40, 3).astype(np.uint8)
        photo = self._save(Image.fromarray(pixels), "photo.png")
        result = image_ops_registry.run("crop", photo, {"left": 25, "bottom": 40}, self.context)
        self.assertRegex(result.path.name, r"^photo-crop-\d{8}-\d{6}-[0-9a-f]{6}\.png$")
        self.assertIsNone(result.mask_path)
        out = _open(result.path)
        self.assertEqual((out.mode, out.size), ("RGB", (30, 12)))
        np.testing.assert_array_equal(np.asarray(out), pixels[:12, 10:])
        self.assertEqual(_open(photo).size, (40, 20))

    def test_crop_keeps_transparency(self) -> None:
        photo = self._save(Image.new("RGBA", (10, 10), (1, 2, 3, 0)), "cut.png")
        result = image_ops_registry.run("crop", photo, {"top": 20}, self.context)
        self.assertEqual(_open(result.path).mode, "RGBA")

    def test_colour_key_transparency_is_honoured(self) -> None:
        # RGB and L PNGs can carry their transparency as a tRNS colour key.
        for mode, key in (("RGB", (0, 0, 0)), ("L", 0)):
            with self.subTest(mode=mode):
                keyed = Image.new(mode, (40, 20), key)
                keyed.paste((200, 30, 30) if mode == "RGB" else 200, (25, 2, 35, 12))
                path = self.workspace / f"keyed-{mode}.png"
                keyed.save(path, transparency=key)
                self.assertIn("transparency", _open(path).info)

                cropped = _open(image_ops_registry.run("crop", path, {"left": 10}, self.context).path)
                self.assertEqual(cropped.mode, "RGBA")
                self.assertEqual(cropped.getpixel((0, 0))[3], 0)

                framed = _open(image_ops_registry.run("auto_frame", path, {"margin": 0, "size": 512}, self.context).path)
                self.assertEqual(_visible_box(framed), (0, 0, 512, 512))

    def test_crop_edges_are_clamped(self) -> None:
        self.assertEqual(image_ops_registry.resolve_params("crop", {"left": 150})["left"], 99.0)

    def test_crop_accepts_fractional_percentages(self) -> None:
        path = self._save(Image.new("RGB", (1000, 500), (10, 20, 30)), "wide.png")
        result = image_ops_registry.run("crop", path, {"left": 12.5, "top": 10.2}, self.context)
        self.assertEqual(_open(result.path).size, (875, 449))

    def test_crop_refuses_an_empty_box(self) -> None:
        path = self._save(Image.new("RGB", (100, 100), (10, 20, 30)), "sq.png")
        for params in ({"left": 60, "right": 40}, {"top": 60, "bottom": 40}):
            with self.subTest(params=params):
                with self.assertRaises(ImageOpInputError):
                    image_ops_registry.run("crop", path, params, self.context)

    def test_auto_frame_centers_an_off_center_cutout(self) -> None:
        cutout = Image.new("RGBA", (400, 300), (0, 0, 0, 0))
        cutout.paste((30, 200, 30, 255), (10, 200, 110, 290))  # 100x90, bottom-left
        path = self._save(cutout, "cat-nobg.png")
        result = image_ops_registry.run("auto_frame", path, {"margin": 10, "size": 512}, self.context)
        self.assertRegex(result.path.name, r"^cat-nobg-framed-\d{8}-\d{6}-[0-9a-f]{6}\.png$")
        framed = _open(result.path)
        self.assertEqual((framed.mode, framed.size), ("RGBA", (512, 512)))
        left, top, right, bottom = _visible_box(framed)
        margin = round(512 * 0.10)
        self.assertEqual((left, 512 - right), (margin, margin))
        self.assertLessEqual(abs(top - (512 - bottom)), 1)

    def test_auto_frame_defaults_to_1024(self) -> None:
        cutout = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
        cutout.paste((255, 0, 0, 255), (0, 0, 8, 8))
        result = image_ops_registry.run("auto_frame", self._save(cutout, "dot.png"), {}, self.context)
        self.assertEqual(_open(result.path).size, (1024, 1024))
        self.assertEqual(_visible_box(_open(result.path))[0], 102)

    def test_auto_frame_rejects_an_unknown_resolution(self) -> None:
        with self.assertRaises(ValueError):
            image_ops_registry.resolve_params("auto_frame", {"size": 999})

    def test_auto_frame_needs_transparency(self) -> None:
        opaque = self._save(Image.new("RGB", (16, 16), (9, 9, 9)), "photo.jpg")
        with self.assertRaisesRegex(ImageOpInputError, "remove the background"):
            image_ops_registry.run("auto_frame", opaque, {}, self.context)
        pasted = self._save(Image.new("RGBA", (16, 16), (9, 9, 9, 255)), "pasted.png")
        with self.assertRaisesRegex(ImageOpInputError, "remove the background"):
            image_ops_registry.run("auto_frame", pasted, {}, self.context)
        clear = self._save(Image.new("RGBA", (16, 16), (9, 9, 9, 0)), "clear.png")
        with self.assertRaisesRegex(ImageOpInputError, "no subject"):
            image_ops_registry.run("auto_frame", clear, {}, self.context)
        self.assertFalse((self.workspace / "Images").exists())


if __name__ == "__main__":
    unittest.main()
