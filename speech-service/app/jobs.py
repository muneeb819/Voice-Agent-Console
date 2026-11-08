from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
from contextlib import contextmanager
import threading
import time
import uuid
from pathlib import Path

from app import metrics
from app.audio import AudioError, decode_file

log = logging.getLogger("jobs")


class JobStore:
    """Tiny durable job table (SQLite, WAL). Survives restarts; queued/running jobs are re-queued."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        with self._conn() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.execute(
                """CREATE TABLE IF NOT EXISTS jobs(
                id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL,
                updated REAL NOT NULL, filename TEXT, params TEXT NOT NULL, error TEXT)"""
            )

    @contextmanager
    def _conn(self):
        c = sqlite3.connect(self.path, timeout=30)
        c.row_factory = sqlite3.Row
        try:
            with c:
                yield c
        finally:
            c.close()

    def create(self, owner: str, filename: str, params: dict) -> str:
        jid, now = uuid.uuid4().hex, time.time()
        with self._lock, self._conn() as c:
            c.execute(
                "INSERT INTO jobs VALUES(?,?,?,?,?,?,?,NULL)",
                (jid, owner, "queued", now, now, filename, json.dumps(params)),
            )
        return jid

    def get(self, jid: str) -> dict | None:
        with self._conn() as c:
            r = c.execute("SELECT * FROM jobs WHERE id=?", (jid,)).fetchone()
        return dict(r) if r else None

    def set_status(self, jid: str, status: str, error: str | None = None) -> None:
        with self._lock, self._conn() as c:
            c.execute("UPDATE jobs SET status=?, updated=?, error=? WHERE id=?", (status, time.time(), error, jid))

    def incomplete(self) -> list[dict]:
        with self._conn() as c:
            return [dict(r) for r in c.execute("SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY created")]

    def expired(self, older_than: float) -> list[str]:
        with self._conn() as c:
            return [
                r["id"]
                for r in c.execute(
                    "SELECT id FROM jobs WHERE updated<? AND status NOT IN ('queued','running')", (older_than,)
                )
            ]

    def delete(self, jid: str) -> bool:
        with self._lock, self._conn() as c:
            cur = c.execute("DELETE FROM jobs WHERE id=? AND status NOT IN ('queued','running')", (jid,))
            return cur.rowcount > 0


class JobManager:
    def __init__(self, rt):
        self.rt = rt
        s = rt.settings
        self.store = JobStore(s.data_dir / "jobs.sqlite3")
        self.upload_dir = s.data_dir / "uploads"
        self.result_dir = s.data_dir / "results"
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=s.job_queue_max)
        self._tasks: list[asyncio.Task] = []

    def upload_path(self, jid: str) -> Path:
        return self.upload_dir / jid

    def result_path(self, jid: str) -> Path:
        return self.result_dir / f"{jid}.json"

    async def start(self) -> None:
        incomplete = await asyncio.to_thread(self.store.incomplete)
        self._tasks = [asyncio.create_task(self._worker()) for _ in range(self.rt.settings.job_workers)]
        self._tasks.append(asyncio.create_task(self._janitor()))
        # Running jobs plus the previously full queue can exceed queue_max.
        # Feed recovery in the background as workers make room instead of
        # failing startup with QueueFull or dropping persisted jobs.
        self._tasks.append(asyncio.create_task(self._recover(incomplete)))
        metrics.JOBS_QUEUED.set(self.queue.qsize())

    async def _recover(self, jobs: list[dict]) -> None:
        for job in jobs:
            jid = job["id"]
            if self.upload_path(jid).exists():
                await asyncio.to_thread(self.store.set_status, jid, "queued")
                await self.queue.put(jid)
                metrics.JOBS_QUEUED.set(self.queue.qsize())
                log.info("requeued job after restart", extra={"event": "job_requeue"})
            else:
                await asyncio.to_thread(self.store.set_status, jid, "failed", "upload lost during restart")

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    def submit(self, jid: str) -> bool:
        try:
            self.queue.put_nowait(jid)
        except asyncio.QueueFull:
            return False
        metrics.JOBS_QUEUED.set(self.queue.qsize())
        return True

    async def _worker(self) -> None:
        while True:
            jid = await self.queue.get()
            try:
                await self._process(jid)
            finally:
                self.queue.task_done()
                metrics.JOBS_QUEUED.set(self.queue.qsize())

    async def _process(self, jid: str) -> None:
        s = self.rt.settings
        job = await asyncio.to_thread(self.store.get, jid)
        if not job:
            return
        await asyncio.to_thread(self.store.set_status, jid, "running")
        finished = False
        try:
            p = json.loads(job["params"])
            audio = await asyncio.to_thread(decode_file, self.upload_path(jid), s.max_audio_seconds)
            result = await self.rt.transcribe(audio, mode="job", wait_forever=True, **p)
            await asyncio.to_thread(self.result_path(jid).write_text, json.dumps(result, ensure_ascii=False))
            await asyncio.to_thread(self.store.set_status, jid, "completed")
            finished = True
            metrics.JOBS_TOTAL.labels("completed").inc()
        except AudioError as exc:
            await asyncio.to_thread(self.store.set_status, jid, "failed", str(exc))
            finished = True
            metrics.JOBS_TOTAL.labels("failed").inc()
        except Exception as exc:  # noqa: BLE001
            log.exception("job failed", extra={"event": "job_failed"})
            await asyncio.to_thread(self.store.set_status, jid, "failed", "internal error")
            finished = True
            metrics.JOBS_TOTAL.labels("failed").inc()
            _ = exc
        finally:
            # Cancellation at shutdown is not a terminal outcome: retain
            # the upload so the persisted job can actually be resumed.
            if finished:
                self.upload_path(jid).unlink(missing_ok=True)

    async def _janitor(self) -> None:
        while True:
            await asyncio.sleep(600)
            try:
                cutoff = time.time() - self.rt.settings.retention_hours * 3600
                for jid in await asyncio.to_thread(self.store.expired, cutoff):
                    if await asyncio.to_thread(self.store.delete, jid):
                        self.result_path(jid).unlink(missing_ok=True)
            except Exception:  # noqa: BLE001
                log.exception("janitor error")
