#!/usr/bin/env bash
# Publish the Voice Agent Console on an AWS EC2 instance behind TLS.
#
#   https://<instance-ip>:533/   ->  nginx (TLS)  ->  127.0.0.1:534 (Node)
#
# The Node server speaks plain HTTP only (src/server.ts uses http.createServer),
# so TLS has to be terminated in front of it. The app derives "Secure" session
# cookies from X-Forwarded-Proto, which is why TRUST_PROXY must name the proxy.
#
# Run this ON the instance, from an extracted release or a git checkout:
#
#   sudo bash deploy/aws-deploy.sh --ip 3.107.192.118
#
# Safe to re-run: an existing .env and TLS certificate are preserved.
set -euo pipefail

PUBLIC_IP=""
TLS_PORT="533"
APP_PORT="534"
INSTALL_DIR="/opt/voice-agent-console"
CERT_DIR="/etc/voice-agent-console/tls"
SELF_SIGNED="yes"
CERT_FILE=""
KEY_FILE=""

usage() {
  cat <<'USAGE'
Usage: sudo bash deploy/aws-deploy.sh --ip <public-ip> [options]

  --ip <address>       Public IP or DNS name clients will use (required).
  --tls-port <port>    Public HTTPS port (default 533).
  --app-port <port>    Loopback Node port behind nginx (default 534).
  --install-dir <dir>  Install root (default /opt/voice-agent-console).
  --cert <path>        Use an existing certificate instead of self-signed.
  --key <path>         Matching private key (required with --cert).

Notes
  * A bare IP cannot get a publicly trusted certificate from Let's Encrypt.
    Without --cert/--key this script creates a self-signed certificate, so
    browsers will show a warning until you install a real certificate or put
    the instance behind a load balancer / CloudFront with a DNS name.
  * Open the TLS port in the instance's AWS security group. This script does
    not change AWS networking, and it never opens the SIP/RTP bridge ports.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ip) PUBLIC_IP="${2:-}"; shift 2 ;;
    --tls-port) TLS_PORT="${2:-}"; shift 2 ;;
    --app-port) APP_PORT="${2:-}"; shift 2 ;;
    --install-dir) INSTALL_DIR="${2:-}"; shift 2 ;;
    --cert) CERT_FILE="${2:-}"; SELF_SIGNED="no"; shift 2 ;;
    --key) KEY_FILE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$PUBLIC_IP" ] || { echo "ERROR: --ip is required." >&2; usage; exit 2; }
if [ "$SELF_SIGNED" = "no" ]; then
  [ -n "$CERT_FILE" ] && [ -n "$KEY_FILE" ] || { echo "ERROR: --cert requires --key." >&2; exit 2; }
  [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ] || { echo "ERROR: certificate or key not found." >&2; exit 2; }
fi
[ "$(id -u)" -eq 0 ] || { echo "ERROR: run with sudo (needs systemd + nginx)." >&2; exit 1; }

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== [1/7] Checking prerequisites ==="
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js 22.5+ is required (node:sqlite). Install it first:" >&2
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs" >&2
  exit 1
fi
NODE_VERSION="$(node -p 'process.versions.node')"
node -e 'const [M,m]=process.versions.node.split(".").map(Number); process.exit(M>22||(M===22&&m>=5)?0:1)' || {
  echo "ERROR: Node ${NODE_VERSION} is too old; 22.5+ is required." >&2; exit 1; }
echo "Node ${NODE_VERSION} OK"

if ! command -v nginx >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y nginx openssl
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nginx openssl
  else
    echo "ERROR: install nginx and openssl, then re-run." >&2; exit 1
  fi
fi

echo "=== [2/7] Installing application to ${INSTALL_DIR} ==="
mkdir -p "$INSTALL_DIR"
if [ "$SRC_DIR" != "$INSTALL_DIR" ]; then
  cp -r "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$SRC_DIR/tsconfig.json" \
        "$SRC_DIR/.env.example" "$SRC_DIR/src" "$SRC_DIR/public" "$SRC_DIR/deploy" "$INSTALL_DIR/"
  mkdir -p "$INSTALL_DIR/tools"
  cp "$SRC_DIR/tools/release-manifest.json" "$INSTALL_DIR/tools/"
fi
mkdir -p "$INSTALL_DIR/data/recordings"

# Never overwrite a live configuration or rotate a password on re-run.
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  GENERATED_PASS="$(openssl rand -hex 24)"
  printf '\n# Set by deploy/aws-deploy.sh\n' >> "$INSTALL_DIR/.env"
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${GENERATED_PASS}|" "$INSTALL_DIR/.env"
  unset GENERATED_PASS
  echo "Created ${INSTALL_DIR}/.env with a generated admin password (not printed)."
else
  echo "Preserving existing ${INSTALL_DIR}/.env"
fi

set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$INSTALL_DIR/.env"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$INSTALL_DIR/.env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$INSTALL_DIR/.env"
  fi
}
# Node stays on loopback; only nginx is exposed. TRUST_PROXY must be the proxy
# address or Secure cookies and client IPs are wrong.
set_env HOST "127.0.0.1"
set_env PORT "$APP_PORT"
set_env TRUST_PROXY "127.0.0.1"
chmod 600 "$INSTALL_DIR/.env"

echo "=== [3/7] Installing dependencies & building ==="
cd "$INSTALL_DIR"
npm ci --include=dev
npm run build

echo "=== [4/7] Configuring TLS ==="
mkdir -p "$CERT_DIR"
if [ "$SELF_SIGNED" = "yes" ]; then
  if [ ! -f "$CERT_DIR/server.crt" ] || [ ! -f "$CERT_DIR/server.key" ]; then
    openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
      -keyout "$CERT_DIR/server.key" -out "$CERT_DIR/server.crt" \
      -subj "/CN=${PUBLIC_IP}" \
      -addext "subjectAltName=IP:${PUBLIC_IP}" 2>/dev/null
    echo "Created a SELF-SIGNED certificate for ${PUBLIC_IP}; browsers will warn."
  else
    echo "Preserving existing self-signed certificate."
  fi
  TLS_CRT="$CERT_DIR/server.crt"
  TLS_KEY="$CERT_DIR/server.key"
else
  install -m 644 "$CERT_FILE" "$CERT_DIR/server.crt"
  install -m 600 "$KEY_FILE" "$CERT_DIR/server.key"
  TLS_CRT="$CERT_DIR/server.crt"
  TLS_KEY="$CERT_DIR/server.key"
fi
chmod 600 "$TLS_KEY"

echo "=== [5/7] Installing systemd service ==="
cat > /etc/systemd/system/voice-agent-console.service <<UNIT
[Unit]
Description=Voice Agent Console (loopback HTTP behind nginx TLS)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=$(command -v node) ${INSTALL_DIR}/dist/server.js
Restart=always
RestartSec=3
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable voice-agent-console.service
systemctl restart voice-agent-console.service

echo "=== [6/7] Configuring nginx TLS reverse proxy on :${TLS_PORT} ==="
cat > /etc/nginx/conf.d/voice-agent-console.conf <<NGINX
# Voice Agent Console — TLS termination for the loopback Node server.
server {
    listen ${TLS_PORT} ssl;
    listen [::]:${TLS_PORT} ssl;
    server_name ${PUBLIC_IP};

    ssl_certificate     ${TLS_CRT};
    ssl_certificate_key ${TLS_KEY};
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:VAC:10m;

    client_max_body_size 25m;
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy same-origin always;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host:\$server_port;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host  \$host:\$server_port;

        # The wallboard and live bot use WebSockets.
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
NGINX

# WebSocket upgrade mapping, declared once at http level.
if [ ! -f /etc/nginx/conf.d/00-vac-websocket.conf ]; then
  cat > /etc/nginx/conf.d/00-vac-websocket.conf <<'WSMAP'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
WSMAP
fi

nginx -t
systemctl enable nginx
systemctl reload nginx || systemctl restart nginx

echo "=== [7/7] Verifying ==="
sleep 3
if ! systemctl is-active --quiet voice-agent-console.service; then
  echo "ERROR: service is not running. See: journalctl -u voice-agent-console.service -n 80" >&2
  exit 1
fi
if ! curl -fsS --max-time 10 "http://127.0.0.1:${APP_PORT}/api/health" >/dev/null; then
  echo "ERROR: the app did not answer /api/health on loopback." >&2
  exit 1
fi
if ! curl -fsSk --max-time 10 "https://127.0.0.1:${TLS_PORT}/api/health" >/dev/null; then
  echo "ERROR: nginx did not answer HTTPS on :${TLS_PORT}." >&2
  exit 1
fi

cat <<DONE

Deployment verified locally on this instance.

  URL:            https://${PUBLIC_IP}:${TLS_PORT}/
  Node (loopback): 127.0.0.1:${APP_PORT}
  Config:         ${INSTALL_DIR}/.env   (admin password is in ADMIN_PASSWORD)
  Logs:           journalctl -u voice-agent-console.service -f

Still required before real use:
  1. Open TCP ${TLS_PORT} in the instance's AWS security group, restricted to
     the operator IPs that need access. This script cannot change AWS rules.
  2. Replace the self-signed certificate, or front the instance with a DNS name
     and an ACM certificate (ALB / CloudFront). Browsers warn on self-signed.
  3. Read the admin password:  sudo grep '^ADMIN_PASSWORD=' ${INSTALL_DIR}/.env
  4. Keep the SIP/RTP bridge ports closed to the internet; set
     BRIDGE_ALLOWED_IPS to your PBX addresses only.
DONE
