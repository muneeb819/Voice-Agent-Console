# Self-hosted Speech Service v1.1.0 (STT + TTS + Consented Voice Cloning)

Production-ready FastAPI speech microservice wrapping **faster-whisper** (STT), **Kokoro-82M** (TTS), and **Chatterbox Turbo** (optional consented voice cloning in an isolated container), wired directly into **Voice-Agent-Console** as a 1-click local STT + TTS provider.

## Quick Run

```bash
cp .env.example .env            # set SPEECH_API_KEYS and SPEECH_DOMAIN
docker compose --profile tls up -d --build            # API + automatic HTTPS
docker compose --profile tls --profile clone up -d    # + voice cloning (set SPEECH_CLONE_URL/TOKEN first)
SPEECH_URL=https://your-domain SPEECH_KEY=... ./scripts/smoke.sh
```
Requires an NVIDIA GPU + NVIDIA Container Toolkit for `SPEECH_BACKEND=real`. First start downloads models into the `model-cache` volume.
Local GPU-less API exploration & integration testing: `make dev` (fake engines, docs at `/docs`). Tests: `make test`.

## API (Bearer or `X-API-Key`)

| Endpoint | Purpose |
|---|---|
| `POST /v1/audio/transcriptions` | OpenAI-compatible file STT (`json`, `verbose_json`, `text`, `srt`, `vtt`), up to `SPEECH_SYNC_MAX_SECONDS` |
| `POST /v1/jobs/transcriptions`, `GET /v1/jobs/{id}`, `/result`, `DELETE` | Durable SQLite WAL queue for long recordings (survives restarts, source audio deleted after processing) |
| `POST /v1/audio/speech` | OpenAI-compatible TTS: `wav pcm ulaw flac mp3 opus`, `sample_rate`, `speed`, `stream:true` (pcm/ulaw), Kokoro + OpenAI voice aliases (`alloy`, `nova`, `echo`, `onyx`, `fable`, `shimmer`) |
| `GET /v1/models`, `GET /v1/voices/stock` | Model discovery & stock Kokoro voice + OpenAI alias registry |
| `WS /v1/stream/stt` | Live STT: JSON config (`encoding: "pcm" \| "ulaw"`, `sample_rate: 8000\|16000\|24000\|48000`), then binary frames -> `partial` / `final` (VAD endpointing) |
| `WS /v1/stream/tts` | Streaming TTS with instant barge-in: `{"type":"speak","text":..}`, `{"type":"cancel"}` |
| `POST/GET/DELETE /v1/voices` | Register a cloned voice **with consent record**; use as `voice: "clone:<id>"` |
| `/healthz` `/readyz` `/metrics` | Liveness, readiness (503 until sequential + batched STT & TTS warm), Prometheus |

Telephony (VICIdial/Asterisk & Voice-Agent-Console): request `response_format: "ulaw"` (8 kHz G.711) or `pcm` with `sample_rate: 8000`; stream live caller audio to `/v1/stream/stt` with `{"sample_rate": 8000, "encoding": "ulaw"}` or `"pcm"`.

## v1.1.0 Fixes Included
1. **Faster-Whisper Batched Inference Fix (`app/engines/stt_whisper.py`)**: Excludes `condition_on_previous_text` when `batch_size > 0` (`BatchedInferencePipeline.transcribe()`) and falls back to `WhisperModel.transcribe()` when `vad=False`; `_warmup()` exercises both sequential and batched paths.
2. **WebSocket Barge-In GPU Semaphore Fix (`app/ws.py`)**: Wraps `rt.tts_chunks(...)` in `contextlib.aclosing(...)` so `{"type": "cancel"}` immediately releases `tts_gate`.
3. **Stateful Resampler Continuity Fix (`app/ws.py`, `app/routes.py`)**: Tracks `enc_sr != sr` instead of hardcoded `sr != 24000` so non-24 kHz voices keep continuous `soxr.ResampleStream` filter state.
4. **OpenAI Voice Aliases & Speakable Text Guard (`app/routes.py`)**: Maps `alloy`, `nova`, `echo`, `onyx`, `fable`, `shimmer` to Kokoro voices and returns clean HTTP 400 on whitespace/punctuation-only text.
5. **Non-Blocking Thread-Safe VAD + Portable FFmpeg + 8 kHz G.711 u-law Live STT (`app/ws.py`, `app/engines/vad.py`, `app/audio.py`)**: Offloads VAD & resampling to worker threads, locks Silero ONNX inference, bundles `imageio-ffmpeg` fallback, and decodes 8 kHz G.711 `ulaw` natively.
