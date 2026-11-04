#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Co-Located ViciBox (OpenSUSE Leap / Ubuntu / Debian) One-Command Installer
# Deploys the unified Voice Agent Console (:533) + AudioSocket (:9092) + SIP/RTP (:5062)
# with Step 4 Production Hardening (ADMIN_PASSWORD + Localhost IP Allowlist + Recordings)
# ==============================================================================

INSTALL_DIR="/opt/voice-agent-console"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== [1/5] Checking Node.js 22.5+ runtime on ViciBox ==="
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found — installing Node.js 22 LTS..."
  if command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install nodejs22 npm22 gcc-c++ make python3
  elif command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs build-essential python3
  fi
fi
echo "Node version: $(node -v)"
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 5)) { console.error("Node.js 22.5 or newer is required for SQLite fallback"); process.exit(1); }'

echo "=== [2/5] Syncing project to ${INSTALL_DIR} ==="
mkdir -p "${INSTALL_DIR}"
cp -r "${SRC_DIR}/package.json" "${SRC_DIR}/package-lock.json" "${SRC_DIR}/tsconfig.json" "${SRC_DIR}/.env.example" \
      "${SRC_DIR}/src" "${SRC_DIR}/public" "${SRC_DIR}/deploy" "${INSTALL_DIR}/"
[ -f "${SRC_DIR}/VICIBOX-PRODUCTION-RUNBOOK.md" ] && cp "${SRC_DIR}/VICIBOX-PRODUCTION-RUNBOOK.md" "${INSTALL_DIR}/" || true
mkdir -p "${INSTALL_DIR}/tools"
cp "${SRC_DIR}/tools/release-manifest.json" "${INSTALL_DIR}/tools/"

mkdir -p "${INSTALL_DIR}/data/recordings"
if [ -f "${SRC_DIR}/data/console.sqlite" ] && [ ! -f "${INSTALL_DIR}/data/console.sqlite" ]; then
  cp "${SRC_DIR}/data/console.sqlite" "${INSTALL_DIR}/data/"
fi
if [ -f "${SRC_DIR}/data/console-state.json" ] && [ ! -f "${INSTALL_DIR}/data/console-state.json" ]; then
  cp "${SRC_DIR}/data/console-state.json" "${INSTALL_DIR}/data/"
fi

if [ ! -f "${INSTALL_DIR}/.env" ]; then
  if [ -f "${SRC_DIR}/.env" ]; then
    cp "${SRC_DIR}/.env" "${INSTALL_DIR}/.env"
    echo "Copied existing configuration to ${INSTALL_DIR}/.env."
  else
    cp "${SRC_DIR}/.env.example" "${INSTALL_DIR}/.env"
    # Generate a password only for a new configuration; never print it in logs.
    GENERATED_PASS="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${GENERATED_PASS}/" "${INSTALL_DIR}/.env"
    unset GENERATED_PASS
    echo "Created loopback-only configuration with a generated admin password in ${INSTALL_DIR}/.env."
  fi
else
  echo "Preserving existing ${INSTALL_DIR}/.env without changing its settings."
fi
chmod 600 "${INSTALL_DIR}/.env"

echo "=== [3/5] Installing dependencies & building TypeScript ==="
cd "${INSTALL_DIR}"
npm ci --include=dev
npm run build

echo "=== [4/5] Detecting Asterisk version & AudioSocket availability ==="
if command -v asterisk >/dev/null 2>&1; then
  AST_VER="$(asterisk -rx 'core show version' 2>/dev/null || true)"
  echo "Detected Asterisk: ${AST_VER}"
  if asterisk -rx "module show like audiosocket" 2>/dev/null | grep -qi "app_audiosocket"; then
    echo "✓ app_audiosocket.so is loaded — Both AudioSocket (:9092) and SIP/RTP (:5062) are ready!"
  else
    echo "ℹ app_audiosocket.so not loaded — Use SIP/RTP Carrier Mode ([ai-bridge] -> 115.186.137.240:5062) in VICIdial Admin -> Carriers."
  fi
fi

echo "=== [5/5] Installing & starting systemd service (voice-agent-bridge.service) ==="
cp "${INSTALL_DIR}/deploy/voice-agent-bridge.service" /etc/systemd/system/voice-agent-bridge.service
systemctl daemon-reload
systemctl enable voice-agent-bridge.service
systemctl restart voice-agent-bridge.service
sleep 2
systemctl --no-pager --full status voice-agent-bridge.service || true
if ! systemctl is-active --quiet voice-agent-bridge.service; then
  echo "Service failed to start; review journalctl -u voice-agent-bridge.service." >&2
  exit 1
fi

echo ""
echo "✓ Voice Agent Console service started."
echo "  Configuration      : ${INSTALL_DIR}/.env (existing settings preserved)"
echo "  Call Recordings    : ${INSTALL_DIR}/data/recordings/*.wav"
echo "  Review HOST, BRIDGE_BIND_HOST, BRIDGE_ALLOWED_IPS and firewall rules before enabling remote access."
