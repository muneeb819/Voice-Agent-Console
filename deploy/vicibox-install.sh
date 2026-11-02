#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Co-Located ViciBox (OpenSUSE Leap / Ubuntu / Debian) One-Command Installer
# Deploys the unified Voice Agent Console (:533) + AudioSocket (:9092) + SIP/RTP (:5062)
# with Step 4 Production Hardening (ADMIN_PASSWORD + Localhost IP Allowlist + Recordings)
# ==============================================================================

INSTALL_DIR="/opt/voice-agent-console"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== [1/5] Checking Node.js 20+ runtime on ViciBox ==="
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found — installing Node.js 20 LTS..."
  if command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install nodejs20 npm20 gcc-c++ make python3 || zypper --non-interactive install nodejs npm gcc-c++ make python3
  elif command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs build-essential python3
  fi
fi
echo "Node version: $(node -v)"

echo "=== [2/5] Syncing project to ${INSTALL_DIR} ==="
mkdir -p "${INSTALL_DIR}"
cp -r "${SRC_DIR}/package.json" "${SRC_DIR}/package-lock.json" "${SRC_DIR}/tsconfig.json" \
      "${SRC_DIR}/src" "${SRC_DIR}/public" "${SRC_DIR}/deploy" "${INSTALL_DIR}/"
[ -f "${SRC_DIR}/VICIBOX-PRODUCTION-RUNBOOK.md" ] && cp "${SRC_DIR}/VICIBOX-PRODUCTION-RUNBOOK.md" "${INSTALL_DIR}/" || true

mkdir -p "${INSTALL_DIR}/data/recordings"
if [ -f "${SRC_DIR}/data/console.sqlite" ] && [ ! -f "${INSTALL_DIR}/data/console.sqlite" ]; then
  cp "${SRC_DIR}/data/console.sqlite" "${INSTALL_DIR}/data/"
fi
if [ -f "${SRC_DIR}/data/console-state.json" ] && [ ! -f "${INSTALL_DIR}/data/console-state.json" ]; then
  cp "${SRC_DIR}/data/console-state.json" "${INSTALL_DIR}/data/"
fi

GENERATED_PASS=""
if [ ! -f "${INSTALL_DIR}/.env" ]; then
  if [ -f "${SRC_DIR}/.env" ]; then
    cp "${SRC_DIR}/.env" "${INSTALL_DIR}/.env"
    chmod 600 "${INSTALL_DIR}/.env"
    echo "Copied pre-configured .env (including DEEPGRAM_API_KEY) to ${INSTALL_DIR}/.env."
  else
    cp "${SRC_DIR}/.env.example" "${INSTALL_DIR}/.env"
    GENERATED_PASS="$(openssl rand -hex 12 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${GENERATED_PASS}/" "${INSTALL_DIR}/.env"
    sed -i "s/^BRIDGE_ALLOWED_IPS=.*/BRIDGE_ALLOWED_IPS=115.186.137.240,::1/" "${INSTALL_DIR}/.env"
    chmod 600 "${INSTALL_DIR}/.env"
    echo "Created hardened ${INSTALL_DIR}/.env (chmod 600, BRIDGE_ALLOWED_IPS=115.186.137.240,::1)."
  fi
fi

if ! grep -Eq '^ADMIN_PASSWORD=.+$' "${INSTALL_DIR}/.env"; then
  GENERATED_PASS="$(openssl rand -hex 24 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if grep -q '^ADMIN_PASSWORD=' "${INSTALL_DIR}/.env"; then
    sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=${GENERATED_PASS}/" "${INSTALL_DIR}/.env"
  else
    printf '\nADMIN_PASSWORD=%s\n' "${GENERATED_PASS}" >> "${INSTALL_DIR}/.env"
  fi
  echo "Generated a strong ADMIN_PASSWORD in ${INSTALL_DIR}/.env."
fi

if grep -q '^PORT=' "${INSTALL_DIR}/.env"; then
  sed -i 's/^PORT=.*/PORT=533/' "${INSTALL_DIR}/.env"
else
  printf '\nPORT=533\n' >> "${INSTALL_DIR}/.env"
fi

if grep -q '^HOST=' "${INSTALL_DIR}/.env"; then
  sed -i 's/^HOST=.*/HOST=0.0.0.0/' "${INSTALL_DIR}/.env"
else
  printf '\nHOST=0.0.0.0\n' >> "${INSTALL_DIR}/.env"
fi

if ! grep -Eq '^BRIDGE_ALLOWED_IPS=.+$' "${INSTALL_DIR}/.env"; then
  if grep -q '^BRIDGE_ALLOWED_IPS=' "${INSTALL_DIR}/.env"; then
    sed -i 's/^BRIDGE_ALLOWED_IPS=.*/BRIDGE_ALLOWED_IPS=115.186.137.240,::1/' "${INSTALL_DIR}/.env"
  else
    printf '\nBRIDGE_ALLOWED_IPS=115.186.137.240,::1\n' >> "${INSTALL_DIR}/.env"
  fi
fi
chmod 600 "${INSTALL_DIR}/.env"

echo "=== [3/5] Installing dependencies & building TypeScript ==="
cd "${INSTALL_DIR}"
npm ci --include=dev || npm install
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

echo ""
echo "✓ Turnkey Step 4 Production Deployment Complete!"
echo "  Console UI         : http://$(hostname -I | awk '{print $1}'):533"
echo "  AudioSocket TCP    : 115.186.137.240:9092 (Protected by BRIDGE_ALLOWED_IPS)"
echo "  SIP + RTP (PCMU)   : 115.186.137.240:5062 (Protected by BRIDGE_ALLOWED_IPS)"
echo "  Call Recordings    : ${INSTALL_DIR}/data/recordings/*.wav"
if [ -n "${GENERATED_PASS}" ]; then
  echo "  Initial Admin Pass : ${GENERATED_PASS}  (saved in ${INSTALL_DIR}/.env)"
fi
echo "  Optional Firewall  : firewall-cmd --permanent --add-port=533/tcp && firewall-cmd --reload"
