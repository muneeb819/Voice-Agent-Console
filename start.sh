#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -d "node_modules" ]; then
  echo "Installing Node.js dependencies..."
  npm ci
fi

echo "Building TypeScript..."
npm run build

echo "Starting Voice Agent Console + Live Simulator + VICIdial Bridge on http://localhost:3000 ..."
exec npm start
