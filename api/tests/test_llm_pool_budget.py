import importlib
import unittest

llm_server = importlib.import_module("services.llm_server")


class _FakeSlot:
    """Stands in for a loaded LlamaServerManager: alive, with a last-used stamp
    and a VRAM estimate."""

    def __init__(self, last_used: float, vram_mb: int, busy: int = 0, port: int = 0) -> None:
        self._last_used = last_used
        self.vram_mb = vram_mb
        self.port = port
        self.busy_count = busy
        self.unloaded = False

    def _alive(self) -> bool:
        return not self.unloaded

    def unload(self) -> None:
        self.unloaded = True


class EstimateVramTests(unittest.TestCase):
    def test_declared_estimate_wins(self):
        self.assertEqual(llm_server.estimate_vram_mb({"vram_estimate_mb": 4200}), 4200)

    def test_custom_model_is_derived_from_file_size(self):
        # 9 GB of weights: enough on its own to fill a 12 GB card.
        mb = llm_server.estimate_vram_mb({"size_bytes": 9 * 1024**3})
        self.assertGreater(mb, 11000)
        self.assertLess(mb, 12500)

    def test_unknown_size_yields_zero(self):
        self.assertEqual(llm_server.estimate_vram_mb({}), 0)


class PoolBudgetTests(unittest.TestCase):
    """Numbers are the ones measured on the reference machine: an RTX 5070
    reporting 11.9 GiB, so a 768 MiB reserve leaves a 11.4 GiB budget."""

    def setUp(self) -> None:
        self.pool = llm_server.LlamaPool()
        self._orig_max = llm_server.resolve_max_models
        self._orig_budget = llm_server.vram_budget_mb
        llm_server.resolve_max_models = lambda: 2
        llm_server.vram_budget_mb = lambda: int(11.9 * 1024) - 768  # 11417

    def tearDown(self) -> None:
        llm_server.resolve_max_models = self._orig_max
        llm_server.vram_budget_mb = self._orig_budget

    def _load(self, **slots) -> None:
        for i, (mid, vram) in enumerate(slots.items()):
            self.pool._slots[mid] = _FakeSlot(last_used=float(i), vram_mb=vram)

    def test_a_pair_that_fits_is_kept(self):
        # qwen3-4b (4200) already loaded, cadquery-coder-7b (6200) incoming.
        self._load(qwen4b=4200)
        self.pool._enforce_limit_locked(reserve=1, incoming_mb=6200)
        self.assertEqual(list(self.pool._slots), ["qwen4b"])

    def test_a_pair_that_does_not_fit_evicts_the_oldest(self):
        # qwen3-4b (4200) + qwen3-vl-8b (7800) = 12000 > 11417.
        self._load(qwen4b=4200)
        self.pool._enforce_limit_locked(reserve=1, incoming_mb=7800)
        self.assertEqual(list(self.pool._slots), [])

    def test_an_oversized_model_gets_the_card_to_itself(self):
        # The custom 14B alone exceeds the budget: it still loads, alone.
        self._load(qwen4b=4200, coder7b=6200)
        self.pool._enforce_limit_locked(reserve=1, incoming_mb=11700)
        self.assertEqual(list(self.pool._slots), [])

    def test_count_limit_still_applies_under_the_budget(self):
        # Three tiny models fit the VRAM budget but not `max_models: 2`.
        self._load(a=500, b=500)
        self.pool._enforce_limit_locked(reserve=1, incoming_mb=500)
        self.assertEqual(list(self.pool._slots), ["b"])

    def test_evicts_least_recently_used_first(self):
        self._load(oldest=4200, newest=4200)
        llm_server.resolve_max_models = lambda: 3
        self.pool._enforce_limit_locked(reserve=1, incoming_mb=7800)
        self.assertNotIn("oldest", self.pool._slots)

    def test_no_gpu_falls_back_to_the_count_rule(self):
        llm_server.vram_budget_mb = lambda: 0
        self._load(a=9000)
        self.pool._enforce_limit_locked(reserve=1, incoming_mb=9000)
        self.assertEqual(list(self.pool._slots), ["a"])

    def test_unknown_estimate_never_evicts(self):
        # A model with no size on disk must not push everything out.
        self._load(a=4200)
        self.pool._enforce_limit_locked(reserve=1, incoming_mb=0)
        self.assertEqual(list(self.pool._slots), ["a"])

    def test_a_concurrent_load_counts_against_the_budget(self):
        # ensure() reserves under the lock but loads outside it, so a slot being
        # started has no process yet. Counting only live slots let two callers
        # (agent turn + workflow LLM node) each load 7.8 GB on an 11.4 GB card.
        loading = _FakeSlot(last_used=0.0, vram_mb=7800, port=llm_server.SERVER_PORT)
        loading.unloaded = True  # reserved: not alive yet
        self.pool._slots["incoming-a"] = loading
        self.pool._loading_ports.add(llm_server.SERVER_PORT)
        self._load(alive_one=4200)

        self.pool._enforce_limit_locked(reserve=1, incoming_mb=7800)
        # 7800 (in flight) + 7800 (incoming) already blows the budget, so the
        # live 4.2 GB model goes.
        self.assertNotIn("alive_one", self.pool._slots)

    def test_a_concurrent_load_counts_against_the_model_limit(self):
        loading = _FakeSlot(last_used=0.0, vram_mb=500, port=llm_server.SERVER_PORT)
        loading.unloaded = True
        self.pool._slots["incoming-a"] = loading
        self.pool._loading_ports.add(llm_server.SERVER_PORT)
        self._load(a=500)  # 1 live + 1 loading + 1 incoming > max_models (2)

        self.pool._enforce_limit_locked(reserve=1, incoming_mb=500)
        self.assertNotIn("a", self.pool._slots)

    def test_a_slot_answering_a_request_is_never_evicted(self):
        # Evicting it would terminate llama-server mid-generation: the caller
        # gets a truncated stream and the node fails with no message.
        self.pool._slots["busy"] = _FakeSlot(last_used=0.0, vram_mb=7800, busy=1)
        self.pool._enforce_limit_locked(reserve=1, incoming_mb=7800)
        self.assertIn("busy", self.pool._slots)

    def test_a_slot_being_started_is_never_evicted(self):
        # From the moment Popen returns, a slot is _alive() while the loading
        # thread still holds its lock for the whole of _wait_for_health (up to
        # 180 s). unload() runs UNDER the pool lock, so evicting it there would
        # block every other pool operation — /llm/status, ensure(), and the
        # unload_all() the 3D pipeline calls to reclaim VRAM — for that long.
        starting = _FakeSlot(last_used=0.0, vram_mb=7800, port=llm_server.SERVER_PORT)
        self.pool._slots["starting"] = starting
        self.pool._loading_ports.add(llm_server.SERVER_PORT)

        self.pool._enforce_limit_locked(reserve=1, incoming_mb=7800)
        self.assertIn("starting", self.pool._slots)
        self.assertFalse(starting.unloaded)

    def test_over_capacity_counts_loads_in_flight(self):
        loading = _FakeSlot(last_used=0.0, vram_mb=7800, port=llm_server.SERVER_PORT)
        loading.unloaded = True  # reserved, no process yet
        self.pool._slots["incoming-a"] = loading
        self.pool._loading_ports.add(llm_server.SERVER_PORT)
        # Nothing is alive, yet the card is already spoken for.
        self.assertTrue(self.pool._over_capacity_locked(7800))
        self.pool._loading_ports.clear()
        self.assertFalse(self.pool._over_capacity_locked(7800))

    def test_only_loads_and_live_requests_are_worth_waiting_for(self):
        # ensure() waits for these to end instead of loading a second model on a
        # one-model card; a merely idle slot is evicted rather than waited on.
        idle = _FakeSlot(last_used=0.0, vram_mb=4200, port=llm_server.SERVER_PORT)
        self.pool._slots["idle"] = idle
        self.assertFalse(self.pool._transient_blockers_locked())

        idle.busy_count = 1
        self.assertTrue(self.pool._transient_blockers_locked())

        idle.busy_count = 0
        self.pool._loading_ports.add(llm_server.SERVER_PORT + 1)
        self.assertTrue(self.pool._transient_blockers_locked())

    def test_no_free_port_raises_a_readable_error(self):
        for i in range(llm_server.MAX_SLOT_PORTS):
            self.pool._loading_ports.add(llm_server.SERVER_PORT + i)
        with self.assertRaises(RuntimeError) as ctx:
            self.pool.ensure("whatever", {"vram_mb": 500})
        self.assertIn("slots", str(ctx.exception))


class ReaperTests(unittest.TestCase):
    def setUp(self) -> None:
        self.pool = llm_server.LlamaPool()

    def test_an_idle_slot_is_unloaded(self):
        old = _FakeSlot(last_used=0.0, vram_mb=4200)
        self.pool._slots["old"] = old
        self.pool._reap_once(now=llm_server.IDLE_TTL_SECONDS + 1)
        self.assertEqual(list(self.pool._slots), [])
        self.assertTrue(old.unloaded)

    def test_a_slot_answering_a_long_request_survives(self):
        # A generation longer than the TTL (Text-to-CAD, a 14B on CPU) used to
        # be killed mid-answer: _last_used only moved once a call had finished.
        busy = _FakeSlot(last_used=0.0, vram_mb=4200, busy=1)
        self.pool._slots["busy"] = busy
        self.pool._reap_once(now=llm_server.IDLE_TTL_SECONDS * 10)
        self.assertEqual(list(self.pool._slots), ["busy"])
        self.assertFalse(busy.unloaded)


    def test_a_slot_being_started_is_not_idle(self):
        # Same reason as the eviction case: the reaper also unloads under the
        # pool lock, so a slot mid-cold-start must not be its victim.
        starting = _FakeSlot(last_used=0.0, vram_mb=4200, port=llm_server.SERVER_PORT)
        self.pool._slots["starting"] = starting
        self.pool._loading_ports.add(llm_server.SERVER_PORT)
        self.pool._reap_once(now=llm_server.IDLE_TTL_SECONDS * 10)
        self.assertEqual(list(self.pool._slots), ["starting"])
        self.assertFalse(starting.unloaded)


class CrashedSlotTests(unittest.TestCase):
    """A llama-server that dies on its own — an OOM partway through a generation —
    leaves its slot object behind. It used to stay in the pool for good: the
    reaper and the limit check both walk live slots only. Its port then looked
    free, the next model was handed the same one, and reviving the crashed model
    reused the dead object's port: _kill_stale_server() killed the live server
    sitting there and the two took turns evicting each other."""

    def setUp(self) -> None:
        self.pool = llm_server.LlamaPool()
        self._orig_max = llm_server.resolve_max_models
        self._orig_budget = llm_server.vram_budget_mb
        llm_server.resolve_max_models = lambda: 2
        llm_server.vram_budget_mb = lambda: 0  # no GPU detected: count rule only

    def tearDown(self) -> None:
        llm_server.resolve_max_models = self._orig_max
        llm_server.vram_budget_mb = self._orig_budget

    def test_the_reaper_drops_a_crashed_slot(self):
        dead = _FakeSlot(last_used=0.0, vram_mb=4200, port=llm_server.SERVER_PORT)
        dead.unloaded = True  # the process is gone, so _alive() is False
        self.pool._slots["dead"] = dead
        # One second old: not idle by any TTL — it is finished, not resting.
        self.pool._reap_once(now=1.0)
        self.assertEqual(list(self.pool._slots), [])

    def test_reviving_a_crashed_model_does_not_take_a_live_slots_port(self):
        created: list = []

        class _StubManager:
            def __init__(self, port: int) -> None:
                self.port = port
                self.vram_mb = 0
                self.busy_count = 0
                self._last_used = 0.0
                self._alive_flag = False
                created.append(self)

            def _alive(self) -> bool:
                return self._alive_flag

            def hold(self) -> None:
                self.busy_count += 1

            def release(self) -> None:
                self.busy_count -= 1

            def unload(self) -> None:
                self._alive_flag = False

            def ensure(self, model_id, spec) -> None:
                self._alive_flag = True

        dead = _StubManager(llm_server.SERVER_PORT)
        live = _StubManager(llm_server.SERVER_PORT)
        live._alive_flag = True
        live._last_used = 1.0
        self.pool._slots = {"dead": dead, "live": live}

        original = llm_server.LlamaServerManager
        llm_server.LlamaServerManager = _StubManager
        try:
            slot = self.pool.ensure("dead", {"vram_mb": 4200})
        finally:
            llm_server.LlamaServerManager = original

        self.assertNotEqual(slot.port, live.port)
        self.assertTrue(live._alive_flag)   # the live server was left alone
        self.assertIs(self.pool._slots["dead"], slot)


class BusyContextTests(unittest.TestCase):
    def test_busy_counts_nest_and_stamp_last_used(self):
        slot = llm_server.LlamaServerManager(port=1)
        self.assertEqual(slot.busy_count, 0)
        with slot.busy():
            self.assertEqual(slot.busy_count, 1)
            with slot.busy():
                self.assertEqual(slot.busy_count, 2)
            self.assertEqual(slot.busy_count, 1)
        self.assertEqual(slot.busy_count, 0)
        self.assertGreater(slot._last_used, 0.0)

    def test_hold_and_release_pair_up(self):
        # ensure(hold=True) claims the slot before returning it; the caller
        # releases it once the request is over.
        slot = llm_server.LlamaServerManager(port=1)
        slot.hold()
        self.assertEqual(slot.busy_count, 1)
        slot.release()
        self.assertEqual(slot.busy_count, 0)

    def test_busy_is_released_when_the_request_raises(self):
        slot = llm_server.LlamaServerManager(port=1)
        with self.assertRaises(ValueError):
            with slot.busy():
                raise ValueError("client disconnected")
        self.assertEqual(slot.busy_count, 0)


if __name__ == "__main__":
    unittest.main()
