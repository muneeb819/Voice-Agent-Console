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
PUBLIC_PORT=""
INSTALL_DIR="/opt/voice-agent-console"
CERT_DIR="/etc/voice-agent-console/tls"
SELF_SIGNED="yes"
CERT_FILE=""
KEY_FILE=""
REAL_IP_FROM=()

usage() {
  cat <<'USAGE'
Usage: sudo bash deploy/aws-deploy.sh --ip <public-ip> [options]

  --ip <address>       Public IP or DNS name clients will use (required).
  --tls-port <port>    Public HTTPS port (default 533).
  --app-port <port>    Loopback Node port behind nginx (default 534).
  --public-port <port> Port browsers actually use, if a load balancer or CDN
                       terminates TLS in front of this nginx (default:
                       --tls-port). Use 443 for an ALB with a 443 listener.
  --real-ip-from <cidr>
                       Trust this CIDR to supply the real client IP via
                       X-Forwarded-For (repeatable). Required when a load
                       balancer fronts this nginx, or every operator shares
                       the balancer's IP for sign-in rate limiting. Use the
                       VPC/subnet CIDRs the balancer runs in. Omit to keep any
                       previously configured value.
  --install-dir <dir>  Install root (default /opt/voice-agent-console).
  --cert <path>        Use an existing certificate instead of self-signed.
  --key <path>         Matching private key (required with --cert).

Notes
  * Without --cert/--key this script creates a self-signed certificate, so
    browsers will show a warning. Publicly trusted IP-address certificates ARE
    available from Let's Encrypt (shortlived profile, ~160h, automated renewal
    required); validation needs port 80 or 443 reachable, not this TLS port.
    See docs/AWS-DEPLOYMENT.md, then re-run with --cert/--key.
  * Open the TLS port in the instance's AWS security group. This script does
    not change AWS networking, and it never opens the SIP/RTP bridge ports.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ip) PUBLIC_IP="${2:-}"; shift 2 ;;
    --tls-port) TLS_PORT="${2:-}"; shift 2 ;;
    --app-port) APP_PORT="${2:-}"; shift 2 ;;
    --public-port) PUBLIC_PORT="${2:-}"; shift 2 ;;
    --real-ip-from) REAL_IP_FROM+=("${2:-}"); shift 2 ;;
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
PUBLIC_PORT="${PUBLIC_PORT:-$TLS_PORT}"
for pair in "TLS_PORT:$TLS_PORT" "APP_PORT:$APP_PORT" "PUBLIC_PORT:$PUBLIC_PORT"; do
  name="${pair%%:*}"; value="${pair#*:}"
  case "$value" in
    ''|*[!0-9]*) echo "ERROR: ${name} must be an integer 1-65535 (got '${value}')." >&2; exit 2 ;;
  esac
  [ "$value" -ge 1 ] && [ "$value" -le 65535 ] || { echo "ERROR: ${name} out of range: ${value}." >&2; exit 2; }
done
[ "$TLS_PORT" != "$APP_PORT" ] || { echo "ERROR: --tls-port and --app-port must differ." >&2; exit 2; }
[ -n "$PUBLIC_IP" ] || exit 2
# A hostname is not a valid IP SAN; OpenSSL would abort mid-deploy.
case "$PUBLIC_IP" in
  *[!0-9.:a-fA-F]*) SAN_TYPE="DNS" ;;
  *:*) SAN_TYPE="IP" ;;
  *.*.*.*) SAN_TYPE="IP" ;;
  *) SAN_TYPE="DNS" ;;
esac
# IPv6 must be bracketed in a URL authority; the SAN keeps it bare.
case "$PUBLIC_IP" in
  *:*) URL_HOST="[${PUBLIC_IP}]" ;;
  *)   URL_HOST="$PUBLIC_IP" ;;
esac
[ "$(id -u)" -eq 0 ] || { echo "ERROR: run with sudo (needs systemd + nginx)." >&2; exit 1; }

# nginx rejects a set_real_ip_from value it cannot parse, so a character-only
# check is not enough: 192.0.2.1/33 would replace a working config and then fail
# nginx -t. Validate the address and the prefix range before writing anything.
# Accepts a bare address or CIDR, IPv4 or IPv6 (write IPv4-mapped addresses as
# plain IPv4).
valid_cidr() {
  local value="$1" addr prefix
  case "$value" in
    */*) addr="${value%%/*}"; prefix="${value#*/}"
         case "$prefix" in ''|*[!0-9]*) return 1 ;; esac
         [ "${#prefix}" -le 3 ] || return 1 ;;
    *)   addr="$value"; prefix="" ;;
  esac
  [ -n "$addr" ] || return 1
  case "$addr" in
    *:*)
      case "$addr" in *[!0-9a-fA-F:]*|*:::*) return 1 ;; esac
      local once="${addr/::/X}"
      case "$once" in *::*) return 1 ;; esac
      local groups=0 part
      local rest="$addr"
      while [ -n "$rest" ]; do
        part="${rest%%:*}"
        if [ -n "$part" ]; then
          [ "${#part}" -le 4 ] || return 1
          groups=$((groups + 1))
        fi
        case "$rest" in *:*) rest="${rest#*:}" ;; *) rest="" ;; esac
      done
      # "::" is the valid all-zeros address and yields no non-empty groups.
      if [ "$groups" -gt 8 ]; then return 1; fi
      if [ "$groups" -eq 0 ] && [ "$addr" != "::" ]; then return 1; fi
      case "$addr" in *::*) [ "$groups" -le 7 ] || return 1 ;; *) [ "$groups" -eq 8 ] || return 1 ;; esac
      case "$addr" in ::*|*::) : ;; *:) return 1 ;; esac
      case "$addr" in :*) case "$addr" in ::*) : ;; *) return 1 ;; esac ;; esac
      if [ -n "$prefix" ]; then [ "$prefix" -le 128 ] || return 1; fi
      ;;
    *)
      case "$addr" in *[!0-9.]*|.*|*.|*..*) return 1 ;; esac
      local octets=0 o rest="$addr"
      while [ -n "$rest" ]; do
        o="${rest%%.*}"
        case "$o" in ''|*[!0-9]*) return 1 ;; esac
        [ "${#o}" -le 3 ] || return 1
        [ "$o" -le 255 ] || return 1
        octets=$((octets + 1))
        case "$rest" in *.*) rest="${rest#*.}" ;; *) rest="" ;; esac
      done
      [ "$octets" -eq 4 ] || return 1
      if [ -n "$prefix" ]; then [ "$prefix" -le 32 ] || return 1; fi
      ;;
  esac
  return 0
}

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

# Appends when the key is absent, so a missing template line can never make the
# write silently do nothing. Values are validated by the callers (loopback
# address and integer ports); reject anything that could break the line.
set_env() {
  local key="$1" value="$2"
  case "$value" in
    *'|'*|*'&'*|*'\'*|*$'\n'*) echo "ERROR: unsafe value for ${key}." >&2; return 1 ;;
  esac
  if grep -qE "^${key}=" "$INSTALL_DIR/.env"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$INSTALL_DIR/.env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$INSTALL_DIR/.env"
  fi
  grep -qE "^${key}=${value}$" "$INSTALL_DIR/.env" || { echo "ERROR: failed to set ${key}." >&2; return 1; }
}

# Never overwrite a live configuration or rotate a password on re-run.
if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  set_env ADMIN_PASSWORD "$(openssl rand -hex 24)"
  echo "Created ${INSTALL_DIR}/.env with a generated admin password (not printed)."
else
  echo "Preserving existing ${INSTALL_DIR}/.env"
fi
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
      -addext "subjectAltName=${SAN_TYPE}:${PUBLIC_IP}" 2>/dev/null
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
# The same-origin check compares the browser Origin to X-Forwarded-Host. Using
# $server_port would advertise the target port (533) even when an ALB serves
# 443, and every login would be rejected. 443 is implicit in an https origin.
if [ "$PUBLIC_PORT" = "443" ]; then
  FORWARDED_HOST='$host'
else
  FORWARDED_HOST="\$host:${PUBLIC_PORT}"
fi
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
        proxy_set_header Host              ${FORWARDED_HOST};
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host  ${FORWARDED_HOST};

        # The wallboard and live bot use WebSockets.
        proxy_set_header Upgrade    \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}
NGINX

# Behind a load balancer, $remote_addr is the balancer, so Node would rate-limit
# every operator against one shared address. Restore the client IP, but only
# from CIDRs the operator explicitly authorised -- never from arbitrary peers.
REALIP_CONF=/etc/nginx/conf.d/00-vac-realip.conf
if [ "${#REAL_IP_FROM[@]}" -gt 0 ]; then
  # Validate every value BEFORE touching the live file. Redirecting straight
  # into $REALIP_CONF would truncate it first, so a rejected value would leave
  # an empty config that later runs then "preserve", silently losing client-IP
  # restoration on the next nginx restart.
  for cidr in "${REAL_IP_FROM[@]}"; do
    if ! valid_cidr "$cidr"; then
      echo "ERROR: invalid address/CIDR '${cidr}' (expected e.g. 10.0.0.0/16 or 2600:1f00::/32)." >&2
      exit 2
    fi
  done
  REALIP_TMP="$(mktemp "${REALIP_CONF}.XXXXXX")"
  {
    echo "# Generated by deploy/aws-deploy.sh --real-ip-from"
    for cidr in "${REAL_IP_FROM[@]}"; do
      echo "set_real_ip_from ${cidr};"
    done
    echo "real_ip_header X-Forwarded-For;"
    echo "real_ip_recursive on;"
  } > "$REALIP_TMP"
  chmod 644 "$REALIP_TMP"
  REALIP_BACKUP=""
  if [ -f "$REALIP_CONF" ]; then
    REALIP_BACKUP="$(mktemp "${REALIP_CONF}.bak.XXXXXX")"
    cp -p "$REALIP_CONF" "$REALIP_BACKUP"
  fi
  mv -f "$REALIP_TMP" "$REALIP_CONF"
  REALIP_WRITTEN=1
  echo "Trusting client IPs from: ${REAL_IP_FROM[*]}"
elif [ -f "$REALIP_CONF" ]; then
  echo "Preserving existing real-IP trust configuration in ${REALIP_CONF}"
fi

# WebSocket upgrade mapping, declared once at http level.
if [ ! -f /etc/nginx/conf.d/00-vac-websocket.conf ]; then
  cat > /etc/nginx/conf.d/00-vac-websocket.conf <<'WSMAP'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
WSMAP
fi

# If the new configuration does not parse, put the previous one back rather
# than leaving nginx unable to restart.
if ! nginx -t; then
  if [ -n "${REALIP_BACKUP:-}" ] && [ -f "${REALIP_BACKUP:-}" ]; then
    mv -f "$REALIP_BACKUP" "$REALIP_CONF"
    echo "nginx config test failed; restored the previous real-IP configuration." >&2
  elif [ "${REALIP_WRITTEN:-0}" = "1" ] && [ -f "$REALIP_CONF" ]; then
    # Only remove a file THIS run created. On a rerun without --real-ip-from the
    # existing config is merely preserved, so an unrelated nginx -t failure
    # (a bad certificate, say) must not delete it.
    rm -f "$REALIP_CONF"
    echo "nginx config test failed; removed the real-IP configuration this run created." >&2
  fi
  echo "ERROR: nginx -t failed; no changes were left active." >&2
  exit 1
fi
[ -n "${REALIP_BACKUP:-}" ] && [ -f "${REALIP_BACKUP:-}" ] && rm -f "$REALIP_BACKUP"
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

  URL:            https://${URL_HOST}:${PUBLIC_PORT}/
  Node (loopback): 127.0.0.1:${APP_PORT}
  Config:         ${INSTALL_DIR}/.env   (admin password is in ADMIN_PASSWORD)
  Logs:           journalctl -u voice-agent-console.service -f

Still required before real use:
  1. Open TCP ${TLS_PORT} in the instance's AWS security group, restricted to
     the operator IPs that need access (or to the load balancer's security
     group when one fronts this nginx). This script cannot change AWS rules.
  2. Replace the self-signed certificate: browsers warn on it. Let's Encrypt
     issues trusted IP-address certificates (shortlived profile, ~160h, so
     renewal must be automated); ACM + an ALB is the alternative.
  3. Read the admin password:  sudo grep '^ADMIN_PASSWORD=' ${INSTALL_DIR}/.env
  4. Keep the SIP/RTP bridge ports closed to the internet; set
     BRIDGE_ALLOWED_IPS to your PBX addresses only.
DONE
