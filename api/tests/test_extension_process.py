import io
import queue
import unittest

from services.extension_process import ExtensionProcess


class ExtensionProcessTests(unittest.TestCase):
    def test_read_loop_writes_sentinel_to_own_queue_only(self) -> None:
        proc = ExtensionProcess(ext_dir=None, manifest={"id": "demo"})  # type: ignore[arg-type]

        old_queue: queue.Queue = queue.Queue()
        new_queue: queue.Queue = queue.Queue()
        proc._queue = new_queue

        fake_proc = type("FakeProc", (), {"stdout": io.StringIO("")})()

        proc._read_loop(fake_proc, old_queue)

        self.assertFalse(old_queue.empty())
        self.assertTrue(new_queue.empty())


if __name__ == "__main__":
    unittest.main()
