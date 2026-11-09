# syntax=docker/dockerfile:1
FROM python:3.11-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 HF_HOME=/models
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg libsndfile1 espeak-ng curl ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10001 speech
WORKDIR /srv

# ---- Main STT + TTS API target ----
FROM base AS api
COPY requirements.txt .
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cu124 torch==2.5.1 \
    && pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && mkdir -p /data /models && chown -R speech:speech /data /models /srv
USER speech
EXPOSE 8000
HEALTHCHECK --interval=20s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS http://localhost:8000/healthz || exit 1
ENTRYPOINT ["/entrypoint.sh"]
CMD ["uvicorn", "--factory", "app.main:app_factory", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--ws-max-size", "1048576", "--limit-concurrency", "100"]

# ---- Isolated Chatterbox Turbo voice-cloning worker target ----
FROM base AS clone
ARG CHATTERBOX_SPEC="chatterbox-tts"
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cu124 torch==2.5.1 torchaudio==2.5.1 \
    && pip install --no-cache-dir fastapi==0.162.0 starlette==1.10.0 "uvicorn[standard]==0.34.0" numpy soundfile "${CHATTERBOX_SPEC}"
COPY clone_service ./clone_service
RUN mkdir -p /data /models && chown -R speech:speech /data /models /srv
USER speech
EXPOSE 8100
HEALTHCHECK --interval=20s --timeout=5s --start-period=120s --retries=3 \
  CMD curl -fsS http://localhost:8100/healthz || exit 1
CMD ["uvicorn", "clone_service.app:app", "--host", "0.0.0.0", "--port", "8100", "--workers", "1", "--ws-max-size", "1048576", "--limit-concurrency", "100"]
