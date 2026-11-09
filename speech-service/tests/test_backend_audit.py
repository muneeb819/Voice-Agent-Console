import asyncio
import json
import sqlite3

import pytest
from starlette.websockets import WebSocketDisconnect

from app.auth import Principal
from app.config import Settings
from app.main import create_app
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


# --------------------------------------------------------------------- A-08
def _limited_client(tmp_path, **overrides):
    settings = Settings(
        backend="fake",
        data_dir=tmp_path,
        api_keys="alice:test-secret",
        **overrides,
    )
    return create_app(settings)


def test_ws_handshake_rate_limits_connection_churn(tmp_path):
    """Opening and instantly closing sockets must not bypass rate limiting."""
    from fastapi.testclient import TestClient

    app = _limited_client(tmp_path, ws_handshake_per_min=2, max_ws_per_key=8)
    with TestClient(app) as client:
        for _ in range(2):
            with client.websocket_connect("/v1/stream/stt", headers=H) as ws:
                ws.send_json({"sample_rate": 16000})
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/v1/stream/stt", headers=H) as ws:
                ws.receive_json()
        assert exc.value.code == 4429
        # The cap is per key: another valid key is unaffected.
        auth = app.state.rt.auth
        assert auth.check_ws_handshake(Principal("bob")) is True


def test_ws_concurrency_slots_are_released_on_disconnect(tmp_path):
    from fastapi.testclient import TestClient

    app = _limited_client(tmp_path, max_ws_per_key=1, ws_handshake_per_min=100)
    with TestClient(app) as client:
        for _ in range(3):
            with client.websocket_connect("/v1/stream/tts", headers=H) as ws:
                ws.send_json({"type": "config", "format": "pcm"})
                assert ws.receive_json()["type"] == "configured"
        assert app.state.rt.auth._ws_open["alice"] == 0


def test_ws_handshake_failure_does_not_leak_concurrency_slot(tmp_path):
    """accept() failing after ws_acquire must return the slot (A-08)."""
    from fastapi.testclient import TestClient

    from app.ws import _open

    app = _limited_client(tmp_path, max_ws_per_key=1)

    class FailingHandshake:
        def __init__(self):
            self.app = app
            # Starlette headers are case-insensitive; a plain dict is not.
            self.headers = {k.lower(): v for k, v in H.items()}
            self.query_params = {}
            self.closed = None

        async def accept(self):
            raise RuntimeError("client vanished during handshake")

        async def close(self, code=1000, reason=None):
            self.closed = code

    with TestClient(app):
        auth = app.state.rt.auth
        for _ in range(3):
            ws = FailingHandshake()
            with pytest.raises(RuntimeError):
                asyncio.run(_open(ws, "stt"))
            assert auth._ws_open["alice"] == 0
        # The key is still usable after repeated failed handshakes.
        assert auth.ws_acquire(Principal("alice")) is True
        auth.ws_release(Principal("alice"))


def test_ws_handshake_limit_must_be_positive():
    with pytest.raises(ValueError):
        Settings(api_keys="k:v", ws_handshake_per_min=0)
