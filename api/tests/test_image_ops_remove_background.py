import importlib.util
import os
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import numpy as np
from PIL import Image

import services.generator_registry as registry
from services.image_ops import ImageOpContext, ImageOpInputError, image_ops_registry
from services.image_ops import birefnet, builtin, outputs
from services.image_ops.requirements import BIREFNET_LITE

HAS_ONNXRUNTIME = importlib.util.find_spec("onnxruntime") is not None


def _open(path) -> Image.Image:
    with Image.open(path) as image:
        image.load()
        return image


class _Input:
    def __init__(self, name: str) -> None:
        self.name = name


class FakeSession:
    """Stands in for an onnxruntime InferenceSession: the left half of the
    frame is foreground (logit +8), the right half background (logit -8)."""

    def __init__(self) -> None:
        self.feeds = []

    def get_inputs(self):
        return [_Input("input_image")]

    def run(self, output_names, feeds):
        self.feeds.append(feeds)
        logits = np.full((1, 1, birefnet.INPUT_SIZE, birefnet.INPUT_SIZE), -8.0, dtype=np.float32)
        logits[..., : birefnet.INPUT_SIZE // 2] = 8.0
        return [logits]


class AlphaMathTests(unittest.TestCase):
    def test_zero_threshold_keeps_soft_alpha(self) -> None:
        alpha = np.array([[0.0, 0.25, 0.5, 1.0]], dtype=np.float32)
        np.testing.assert_allclose(birefnet.apply_edge_threshold(alpha, 0.0), alpha)

    def test_threshold_hardens(self) -> None:
        alpha = np.array([[0.0, 0.25, 0.5, 0.75, 1.0]], dtype=np.float32)
        np.testing.assert_allclose(birefnet.apply_edge_threshold(alpha, 0.5), [[0.0, 0.0, 0.0, 0.5, 1.0]])
        np.testing.assert_allclose(
            birefnet.apply_edge_threshold(alpha, 0.2), np.clip((alpha - 0.2) / 0.8, 0, 1), rtol=1e-6
        )

    def test_to_uint8_rounds_and_clamps(self) -> None:
        self.assertEqual(birefnet.to_uint8(np.array([-1.0, 0.0, 0.5, 1.0, 2.0])).tolist(), [0, 0, 128, 255, 255])

    def test_preprocess_normalizes_to_nchw(self) -> None:
        tensor = birefnet.preprocess(Image.new("RGB", (8, 6), (255, 0, 128)))
        self.assertEqual(tensor.shape, (1, 3, 1024, 1024))
        self.assertEqual(tensor.dtype, np.float32)
        np.testing.assert_allclose(tensor[0, :, 0, 0], [(1 - 0.485) / 0.229, (0 - 0.456) / 0.224, (128 / 255 - 0.406) / 0.225], rtol=1e-5)

    def test_predict_alpha_applies_sigmoid_and_resizes_back(self) -> None:
        alpha = birefnet.predict_alpha(FakeSession(), Image.new("RGB", (40, 10)))
        self.assertEqual(alpha.shape, (10, 40))
        self.assertGreater(alpha[:, :19].min(), 0.99)
        self.assertLess(alpha[:, 21:].max(), 0.01)


class OutputNamingTests(unittest.TestCase):
    def test_sanitize_stem(self) -> None:
        self.assertEqual(outputs.sanitize_stem("My Photo (1).JPG"), "My-Photo-1")
        self.assertEqual(outputs.sanitize_stem("Éclair.png"), "Eclair")
        self.assertEqual(outputs.sanitize_stem("con.png"), "image")
        self.assertEqual(outputs.sanitize_stem("!!!.png"), "image")
        self.assertEqual(len(outputs.sanitize_stem("x" * 200 + ".png")), 60)

    def test_names_share_stamp_and_suffix(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            now = datetime(2026, 1, 2, 3, 4, 5)
            paths = outputs.write_new_files(Path(tmp) / "Images", "cat", [("nobg", b"a"), ("mask", b"b")], now=now, token=lambda: "abcdef")
            self.assertEqual([p.name for p in paths], ["cat-nobg-20260102-030405-abcdef.png", "cat-mask-20260102-030405-abcdef.png"])
            self.assertEqual(paths[0].read_bytes(), b"a")

    def test_never_overwrites(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            images = Path(tmp)
            now = datetime(2026, 1, 2, 3, 4, 5)
            # Only the mask name of the first suffix is taken: the set moves on as a pair.
            taken = images / "cat-mask-20260102-030405-aaaaaa.png"
            taken.write_bytes(b"keep")
            tokens = iter(["aaaaaa", "bbbbbb"])
            paths = outputs.write_new_files(images, "cat", [("nobg", b"a"), ("mask", b"b")], now=now, token=lambda: next(tokens))
            self.assertEqual([p.name for p in paths], ["cat-nobg-20260102-030405-bbbbbb.png", "cat-mask-20260102-030405-bbbbbb.png"])
            self.assertEqual(taken.read_bytes(), b"keep")
            self.assertFalse((images / "cat-nobg-20260102-030405-aaaaaa.png").exists())

    def test_gives_up_after_too_many_clashes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            now = datetime(2026, 1, 2, 3, 4, 5)
            (Path(tmp) / "cat-nobg-20260102-030405-aaaaaa.png").write_bytes(b"x")
            with self.assertRaises(FileExistsError):
                outputs.write_new_files(Path(tmp), "cat", [("nobg", b"a")], now=now, token=lambda: "aaaaaa", attempts=3)


class SessionCacheTests(unittest.TestCase):
    def test_session_is_built_once_and_rebuilt_when_the_file_changes(self) -> None:
        built = []
        cache = birefnet.SessionCache(lambda path: built.append(path) or object())
        with tempfile.TemporaryDirectory() as tmp:
            model = Path(tmp) / "model.onnx"
            model.write_bytes(b"a")
            first = cache.get(model)
            self.assertIs(cache.get(model), first)
            time.sleep(0.01)
            model.write_bytes(b"bb")
            os.utime(model, ns=(time.time_ns(), time.time_ns() + 10_000_000))
            self.assertIsNot(cache.get(model), first)
        self.assertEqual(len(built), 2)


class RemoveBackgroundTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self.workspace = root / "workspace"
        self.models = root / "models"
        self.session = FakeSession()
        self._patches = [
            patch.object(registry, "WORKSPACE_DIR", self.workspace),
            patch.object(registry, "MODELS_DIR", self.models),
            patch.object(birefnet, "session_cache", birefnet.SessionCache(lambda path: self.session)),
        ]
        for p in self._patches:
            p.start()
        # The model "is downloaded" (right size), the runtime is reported present.
        BIREFNET_LITE.path.parent.mkdir(parents=True)
        with open(BIREFNET_LITE.path, "wb") as f:
            f.truncate(BIREFNET_LITE.size)
        self._patches.append(patch("importlib.util.find_spec", side_effect=lambda name, *a: object() if name == "onnxruntime" else _real_find_spec(name, *a)))
        self._patches[-1].start()
        self.context = ImageOpContext(workspace_dir=self.workspace)

    def tearDown(self) -> None:
        for p in reversed(self._patches):
            p.stop()
        self._tmp.cleanup()

    def _photo(self, name: str = "photo.jpg", size=(64, 32), mode="RGB", **save) -> Path:
        rng = np.random.default_rng(0)
        pixels = rng.integers(0, 255, (size[1], size[0], 3), dtype=np.uint8)
        image = Image.fromarray(pixels).convert(mode)
        path = self.workspace / name
        path.parent.mkdir(parents=True, exist_ok=True)
        image.save(path, **save)
        return path

    def test_end_to_end_with_fake_session(self) -> None:
        photo = self._photo("photo.png")
        result = image_ops_registry.run("remove_background", photo, {}, self.context)

        self.assertEqual(result.path.parent, self.workspace / "Images")
        self.assertRegex(result.path.name, r"^photo-nobg-\d{8}-\d{6}-[0-9a-f]{6}\.png$")
        self.assertRegex(result.mask_path.name, r"^photo-mask-\d{8}-\d{6}-[0-9a-f]{6}\.png$")
        out = _open(result.path)
        mask = _open(result.mask_path)
        self.assertEqual((out.mode, out.size), ("RGBA", (64, 32)))
        self.assertEqual((mask.mode, mask.size), ("L", (64, 32)))
        alpha = np.asarray(out.getchannel("A"))
        self.assertTrue((alpha[:, :30] == 255).all())
        self.assertTrue((alpha[:, 34:] == 0).all())
        np.testing.assert_array_equal(np.asarray(mask), alpha)
        # Original pixels are kept untouched under the alpha.
        np.testing.assert_array_equal(np.asarray(out.convert("RGB")), np.asarray(_open(photo).convert("RGB")))
        self.assertEqual(self.session.feeds[0]["input_image"].shape, (1, 3, 1024, 1024))

    def test_two_runs_never_overwrite(self) -> None:
        photo = self._photo("photo.png")
        first = image_ops_registry.run("remove_background", photo, {}, self.context)
        second = image_ops_registry.run("remove_background", photo, {}, self.context)
        self.assertNotEqual(first.path, second.path)
        self.assertEqual(len(list((self.workspace / "Images").iterdir())), 4)

    def test_edge_threshold_is_applied(self) -> None:
        class HalfSession(FakeSession):
            def run(self, output_names, feeds):
                return [np.zeros((1, 1, 1024, 1024), dtype=np.float32)]  # sigmoid(0) = 0.5 everywhere

        birefnet.session_cache = birefnet.SessionCache(lambda path: HalfSession())
        photo = self._photo("photo.png")
        soft = image_ops_registry.run("remove_background", photo, {"edge_threshold": 0}, self.context)
        hard = image_ops_registry.run("remove_background", photo, {"edge_threshold": 0.6}, self.context)
        self.assertTrue((np.asarray(_open(soft.mask_path)) == 128).all())
        self.assertTrue((np.asarray(_open(hard.mask_path)) == 0).all())

    def test_exif_orientation_is_applied(self) -> None:
        exif = Image.Exif()
        exif[0x0112] = 6  # rotate 90° CW on display: 64x32 stored -> 32x64 shown
        photo = self._photo("phone.jpg", exif=exif.tobytes())
        result = image_ops_registry.run("remove_background", photo, {}, self.context)
        self.assertEqual(_open(result.path).size, (32, 64))

    def test_any_mode_is_accepted_and_existing_transparency_is_kept(self) -> None:
        for mode in ("L", "P", "RGBA"):
            with self.subTest(mode=mode):
                photo = self._photo(f"in-{mode}.png", mode=mode)
                result = image_ops_registry.run("remove_background", photo, {}, self.context)
                self.assertEqual(_open(result.path).mode, "RGBA")

        rgba = Image.new("RGBA", (64, 32), (200, 10, 10, 0))  # fully transparent input
        path = self.workspace / "clear.png"
        rgba.save(path)
        result = image_ops_registry.run("remove_background", path, {}, self.context)
        self.assertTrue((np.asarray(_open(result.path).getchannel("A")) == 0).all())

    def test_unreadable_image_is_an_input_error(self) -> None:
        bogus = self.workspace / "bogus.png"
        bogus.parent.mkdir(parents=True, exist_ok=True)
        bogus.write_bytes(b"not an image")
        with self.assertRaises(ImageOpInputError):
            image_ops_registry.run("remove_background", bogus, {}, self.context)
        self.assertFalse((self.workspace / "Images").exists())


_real_find_spec = importlib.util.find_spec


@unittest.skipUnless(HAS_ONNXRUNTIME, "onnxruntime is not installed")
class RealModelTests(unittest.TestCase):
    """Runs the real model when this environment has onnxruntime and the
    weights are already downloaded; never downloads anything itself."""

    def test_real_inference_produces_a_mask(self) -> None:
        if not BIREFNET_LITE.is_ready():
            self.skipTest("BiRefNet-lite weights are not downloaded")
        session = birefnet.SessionCache().get(BIREFNET_LITE.path)
        image = Image.new("RGB", (128, 96), (240, 240, 240))
        image.paste((200, 30, 30), (40, 24, 88, 72))
        alpha = birefnet.predict_alpha(session, image)
        self.assertEqual(alpha.shape, (96, 128))
        self.assertGreaterEqual(alpha.min(), 0.0)
        self.assertLessEqual(alpha.max(), 1.0)


if __name__ == "__main__":
    unittest.main()
