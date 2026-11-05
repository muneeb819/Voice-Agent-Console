FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Run as UID 1000 (compatible with Hugging Face Spaces, Kubernetes & standard Docker)
RUN useradd -m -u 1000 appuser
WORKDIR /home/appuser/app

COPY --chown=appuser:appuser package.json package-lock.json ./
USER appuser
RUN npm ci --no-audit --no-fund

COPY --chown=appuser:appuser . .
RUN npm run build && mkdir -p data/recordings

ENV PORT=533
ENV HOST=0.0.0.0
EXPOSE 533

CMD ["npm", "start"]
