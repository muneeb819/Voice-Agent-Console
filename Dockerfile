FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Run as UID 1000 (compatible with Hugging Face Spaces, Kubernetes & standard Docker).
# Ports below 1024 are privileged on Linux, so the container listens on 8080.
RUN useradd -m -u 1000 appuser \
  && mkdir -p /data/recordings \
  && chown -R appuser:appuser /data
WORKDIR /home/appuser/app

COPY --chown=appuser:appuser package.json package-lock.json ./
USER appuser
RUN npm ci --no-audit --no-fund

COPY --chown=appuser:appuser . .
RUN npm run build \
  && mkdir -p data/recordings \
  && npm prune --omit=dev --no-audit --no-fund

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    VAC_DATA_DIR=/data \
    VAC_ENV_FILE=/data/.env
EXPOSE 8080
VOLUME ["/data"]

# The server refuses to start on a non-loopback interface without credentials.
# Pass ADMIN_PASSWORD (or mount a prepared .env) and keep the data volume.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
