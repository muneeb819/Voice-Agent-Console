import asyncio
from types import SimpleNamespace

from app.jobs import JobManager


def make_runtime(tmp_path, *, block=False, queue_max=1):
    for name in ("uploads", "results"):
        (tmp_path / name).mkdir(exist_ok=True)

    class FakeRuntime:
        settings = SimpleNamespace(
            data_dir=tmp_path, job_queue_max=queue_max, job_workers=1,
            max_audio_seconds=30, retention_hours=24,
        )

        def __init__(self):
            self.started = asyncio.Event()

        async def transcribe(self, _audio, **_kwargs):
            self.started.set()
            if block:
                await asyncio.Event().wait()
            return {"text": "resumed"}

    return FakeRuntime()


async def wait_for_status(manager, job_ids, status):
    async def check():
        while not all(manager.store.get(jid)["status"] == status for jid in job_ids):
            await asyncio.sleep(0.01)
    await asyncio.wait_for(check(), timeout=5)


def test_shutdown_preserves_upload_and_restart_completes(tmp_path, monkeypatch):
    monkeypatch.setattr("app.jobs.decode_file", lambda *_: b"fake audio")

    async def scenario():
        old_rt = make_runtime(tmp_path, block=True)
        old = JobManager(old_rt)
        await old.start()
        jid = old.store.create("test", "clip.wav", {})
        old.upload_path(jid).write_bytes(b"audio")
        assert old.submit(jid)
        await asyncio.wait_for(old_rt.started.wait(), timeout=5)
        await old.stop()
        assert old.upload_path(jid).exists()
        assert old.store.get(jid)["status"] == "running"

        resumed = JobManager(make_runtime(tmp_path))
        await resumed.start()
        try:
            await wait_for_status(resumed, [jid], "completed")
            assert resumed.result_path(jid).exists()
            assert not resumed.upload_path(jid).exists()
        finally:
            await resumed.stop()

    asyncio.run(scenario())


def test_restart_drains_more_persisted_jobs_than_queue_capacity(tmp_path, monkeypatch):
    monkeypatch.setattr("app.jobs.decode_file", lambda *_: b"fake audio")

    async def scenario():
        manager = JobManager(make_runtime(tmp_path, queue_max=1))
        ids = []
        for _ in range(3):
            jid = manager.store.create("test", "clip.wav", {})
            manager.upload_path(jid).write_bytes(b"audio")
            ids.append(jid)
        manager.store.set_status(ids[0], "running")
        missing = manager.store.create("test", "missing.wav", {})
        await manager.start()  # must not raise QueueFull
        try:
            await wait_for_status(manager, ids, "completed")
            await wait_for_status(manager, [missing], "failed")
            assert manager.store.get(missing)["error"] == "upload lost during restart"
            assert all(not manager.upload_path(jid).exists() for jid in ids)
        finally:
            await manager.stop()

    asyncio.run(scenario())
