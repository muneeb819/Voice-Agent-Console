import asyncio
import json
import sqlite3

import pytest
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.jobs import JobStore
from app.engines.base import aiter_blocking
from tests.conftest import H


def test_invalid_limits_rejected():
    with pytest.raises(ValueError):
        Settings(api_keys="k:v", job_workers=0)
    with pytest.raises(ValueError):
        Settings(api_keys="k:v", live_endpoint_ms=0)


def test_job_store_closes_connections_and_delete_is_conditional(tmp_path):
    store = JobStore(tmp_path / "jobs.sqlite3")
    jid = store.create("owner", "a.wav", {})
    for _ in range(50):
        assert store.get(jid)["status"] == "queued"
    store.set_status(jid, "running")
    assert store.delete(jid) is False
    store.set_status(jid, "completed")
    assert store.delete(jid) is True
    # If connections leaked, this exclusive lock would fail after many operations.
    with sqlite3.connect(tmp_path / "jobs.sqlite3", timeout=0.1) as c:
        c.execute("PRAGMA quick_check")


def test_bounded_aiter_blocking_cancellation():
    async def scenario():
        produced = 0

        def factory():
            nonlocal produced
            for i in range(10000):
                produced += 1
                yield i

        gen = aiter_blocking(factory)
        assert await gen.__anext__() == 0
        await gen.aclose()
        await asyncio.sleep(0.1)
        assert produced < 100

    asyncio.run(scenario())


def test_ws_stt_rejects_bad_config(client):
    with client.websocket_connect("/v1/stream/stt", headers=H) as ws:
        ws.send_json({"endpoint_ms": None})
        msg = ws.receive_json()
        assert msg["type"] == "error"


def test_ws_tts_rejects_bad_config_and_recovers(client):
    with client.websocket_connect("/v1/stream/tts", headers=H) as ws:
        ws.send_json({"type": "config", "speed": 99})
        assert ws.receive_json()["type"] == "error"
        ws.send_json({"type": "config", "format": "pcm"})
        assert ws.receive_json()["type"] == "configured"
        ws.send_json({"type": "speak", "id": "ok", "text": "Hello."})
        assert ws.receive_json()["type"] == "start"
        while True:
            msg = ws.receive()
            if msg.get("text") and json.loads(msg["text"])["type"] == "done":
                break


def test_request_id_is_sanitized(client):
    r = client.get("/healthz", headers={"X-Request-ID": "bad\r\ninjected"})
    assert r.status_code == 200
    assert "\n" not in r.headers["x-request-id"]
