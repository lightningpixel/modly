"""Persisted run history (one record per generation, workflow or mesh-op run).

The live job table in ``routers.generation`` is in memory and purged 30 minutes
after a job ends, so on its own nothing survives a restart. This store keeps a
``RunRecord`` (see ``schemas.runs`` -- the shape the provenance model reuses) per
run in a single JSON file at the workspace root.

Robustness rules:
- Writes are atomic (temp file + ``os.replace``) so a crash never leaves half a file.
- A missing file is an empty history; a corrupt one is moved aside and replaced.
- Records still pending/running in a file this process did not write them to were
  left behind by a backend that stopped mid-run: they become ``interrupted``.
- The history is capped (``max_records``); the oldest finished runs go first.
- I/O failures are logged, never raised: history must not break a generation.

The store is inert until ``start()`` gives it a path, so importing the routers
(tests, tooling) never writes into a real workspace.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from pydantic import ValidationError

from schemas.runs import TERMINAL_RUN_STATUSES, RunKind, RunRecord, RunStep

RUN_HISTORY_FILENAME = ".modly-run-history.json"
DEFAULT_MAX_RECORDS = 500
MAX_STEPS = 200
MAX_ERROR_CHARS = 4000
_FILE_VERSION = 1
INTERRUPTED_ERROR = "Interrupted: Modly stopped before this run finished"

# Extensions report progress through the step label ("Sampling 12/50", "Denoising 40%"),
# so counters are folded out before deciding whether a label starts a new step.
_STEP_COUNTERS = re.compile(r"[\d.,%/]+")


def _step_key(name: str) -> str:
    return _STEP_COUNTERS.sub("#", name).strip()


def _truncate_error(error: Optional[str]) -> Optional[str]:
    if error is None or len(error) <= MAX_ERROR_CHARS:
        return error
    # Tracebacks end with the actual exception, so keep the tail.
    return "…" + error[-(MAX_ERROR_CHARS - 1):]


class RunHistoryStore:
    def __init__(self, max_records: int = DEFAULT_MAX_RECORDS) -> None:
        self.max_records = max_records
        self._lock = threading.RLock()
        self._path_provider: Optional[Callable[[], Path]] = None
        self._loaded_path: Optional[Path] = None
        self._records: dict[str, RunRecord] = {}
        # Runs this process is still driving; everything else non-terminal on disk is stale.
        self._live: dict[str, RunRecord] = {}

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #

    def start(self, path_provider: Callable[[], Path]) -> None:
        """Enable persistence. The provider is called per operation, so a relocated
        workspace is followed. Loading marks runs a previous backend left behind as
        interrupted."""
        with self._lock:
            self._path_provider = path_provider
            self._loaded_path = None
            self._records = {}
            self._live = {}
            self._sync_path()

    def stop(self) -> None:
        """Graceful shutdown: runs still in flight will never finish."""
        with self._lock:
            if self._path_provider is None:
                return
            if self._live:
                self._sync_path()
                now = time.time()
                for record in self._live.values():
                    self._interrupt(record, now)
                    self._records[record.id] = record
                self._live = {}
                self._persist()
            self._path_provider = None
            self._loaded_path = None
            self._records = {}

    @property
    def enabled(self) -> bool:
        return self._path_provider is not None

    # ------------------------------------------------------------------ #
    # Recording
    # ------------------------------------------------------------------ #

    def begin(
        self,
        run_id: str,
        kind: RunKind,
        *,
        model_id: Optional[str] = None,
        op_id: Optional[str] = None,
        inputs: Optional[dict[str, Any]] = None,
        params: Optional[dict[str, Any]] = None,
    ) -> None:
        """File a pending run (persisted, so a crash before it starts still shows)."""
        if not self.enabled:
            return
        record = RunRecord(
            id=run_id, kind=kind, status="pending", model_id=model_id, op_id=op_id,
            inputs=inputs or {}, params=params or {},
            created_at=time.time(),
        )
        self.save(record)

    def mark_running(self, run_id: str) -> None:
        with self._lock:
            record = self._live.get(run_id)
            if record is None or record.status in TERMINAL_RUN_STATUSES:
                return
            record.status = "running"
            record.started_at = record.started_at or time.time()
            self.save(record)

    def step(self, run_id: str, name: str) -> None:
        """Note the current step label. In memory only -- labels can change many times
        a second; the steps are written out with the next status change."""
        if not name:
            return
        with self._lock:
            record = self._live.get(run_id)
            if record is None:
                return
            now = time.time()
            current = record.steps[-1] if record.steps else None
            if current is not None and current.ended_at is None:
                if _step_key(current.name) == _step_key(name):
                    return
                if len(record.steps) >= MAX_STEPS:
                    return  # the last step absorbs the rest of the run
                current.ended_at = now
                current.status = "done"
            record.steps.append(RunStep(name=name, started_at=now))

    def finish(
        self,
        run_id: str,
        status: str,
        *,
        error: Optional[str] = None,
        output_path: Optional[str] = None,
    ) -> None:
        with self._lock:
            record = self._live.get(run_id)
            if record is None:
                return
            now = time.time()
            record.status = status  # type: ignore[assignment]
            record.ended_at = now
            if error is not None:
                record.error = error
            if output_path is not None:
                record.output_path = output_path
            _close_steps(record, now)
            self.save(record)

    def save(self, record: RunRecord) -> None:
        """Insert or replace a whole record (used directly for renderer-driven workflow
        runs). A non-terminal record is tracked as live by this process."""
        if not self.enabled:
            return
        with self._lock:
            self._sync_path()
            record.inputs = _json_safe(record.inputs)
            record.params = _json_safe(record.params)
            record.error = _truncate_error(record.error)
            if len(record.steps) > MAX_STEPS:
                record.steps = record.steps[:MAX_STEPS]
            if record.status in TERMINAL_RUN_STATUSES:
                self._live.pop(record.id, None)
            else:
                self._live[record.id] = record
            self._records[record.id] = record
            self._apply_retention()
            self._persist()

    # ------------------------------------------------------------------ #
    # Reading
    # ------------------------------------------------------------------ #

    def get(self, run_id: str) -> Optional[RunRecord]:
        if not self.enabled:
            return None
        with self._lock:
            self._sync_path()
            record = self._records.get(run_id)
            return record.model_copy(deep=True) if record is not None else None

    def list(
        self,
        *,
        statuses: Optional[Iterable[str]] = None,
        kinds: Optional[Iterable[str]] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[RunRecord], int]:
        """Newest first. Returns (page, total matching)."""
        if not self.enabled:
            return [], 0
        wanted_status = set(statuses) if statuses else None
        wanted_kind = set(kinds) if kinds else None
        with self._lock:
            self._sync_path()
            matching = [
                r for r in self._records.values()
                if (wanted_status is None or r.status in wanted_status)
                and (wanted_kind is None or r.kind in wanted_kind)
            ]
            matching.sort(key=lambda r: r.created_at, reverse=True)
            page = matching[offset:offset + limit]
            return [r.model_copy(deep=True) for r in page], len(matching)

    # ------------------------------------------------------------------ #
    # Internals (lock held)
    # ------------------------------------------------------------------ #

    def _sync_path(self) -> None:
        """(Re)load when the workspace path changed since the last load."""
        assert self._path_provider is not None
        path = Path(self._path_provider())
        if path == self._loaded_path:
            return
        self._loaded_path = path
        self._records = self._load(path)
        now = time.time()
        stale = False
        for record in self._records.values():
            if record.status not in TERMINAL_RUN_STATUSES and record.id not in self._live:
                self._interrupt(record, now)
                stale = True
        # Live runs keep being written wherever the workspace now is.
        for run_id, record in self._live.items():
            self._records[run_id] = record
        if stale:
            self._persist()

    @staticmethod
    def _interrupt(record: RunRecord, now: float) -> None:
        record.status = "interrupted"
        record.error = record.error or INTERRUPTED_ERROR
        # When it really stopped is unknown; leave ended_at empty rather than invent one.
        for step in record.steps:
            if step.ended_at is None:
                step.status = "interrupted"

    def _load(self, path: Path) -> dict[str, RunRecord]:
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return {}
        except OSError as exc:
            print(f"[RunHistory] Cannot read {path}: {exc}")
            return {}
        try:
            data = json.loads(raw)
            entries = data["runs"] if isinstance(data, dict) else None
            if not isinstance(entries, list):
                raise ValueError("missing 'runs' list")
        except (ValueError, KeyError, TypeError) as exc:
            self._quarantine(path, exc)
            return {}
        records: dict[str, RunRecord] = {}
        for entry in entries:
            try:
                record = RunRecord.model_validate(entry)
            except ValidationError:
                continue  # one bad record must not cost the whole history
            records[record.id] = record
        return records

    @staticmethod
    def _quarantine(path: Path, exc: Exception) -> None:
        target = path.with_name(f"{path.name}.corrupt-{int(time.time())}")
        try:
            os.replace(path, target)
            print(f"[RunHistory] {path} is unreadable ({exc}); moved to {target.name}")
        except OSError as move_exc:
            print(f"[RunHistory] {path} is unreadable ({exc}) and could not be moved: {move_exc}")

    def _apply_retention(self) -> None:
        excess = len(self._records) - self.max_records
        if excess <= 0:
            return
        finished = sorted(
            (r for r in self._records.values() if r.id not in self._live),
            key=lambda r: r.created_at,
        )
        for record in finished[:excess]:
            del self._records[record.id]

    def _persist(self) -> None:
        path = self._loaded_path
        if path is None:
            return
        ordered = sorted(self._records.values(), key=lambda r: r.created_at, reverse=True)
        payload = {
            "version": _FILE_VERSION,
            "runs": [r.model_dump(mode="json", exclude={"duration_s"}) for r in ordered],
        }
        tmp_name: Optional[str] = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_name = tempfile.mkstemp(prefix=f"{path.name}.", suffix=".tmp", dir=path.parent)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp_name, path)
            tmp_name = None
        except OSError as exc:
            print(f"[RunHistory] Cannot write {path}: {exc}")
        finally:
            if tmp_name is not None:
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass


def _close_steps(record: RunRecord, now: float) -> None:
    for step in record.steps:
        if step.ended_at is None:
            step.ended_at = now
            step.status = record.status


def _json_safe(value: dict[str, Any]) -> dict[str, Any]:
    """Params come from callers; keep only what survives a JSON round trip."""
    try:
        return json.loads(json.dumps(value, default=str))
    except (TypeError, ValueError):
        return {}


def workspace_relative(path: Path, workspace: Path) -> str:
    """Workspace-relative POSIX path when inside the workspace, absolute otherwise."""
    try:
        return path.resolve().relative_to(workspace.resolve()).as_posix()
    except (OSError, ValueError):
        return str(path)


run_history = RunHistoryStore()
