#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -d "node_modules" ]; then
  echo "Installing Node.js dependencies..."
  npm ci
fi

echo "Building TypeScript..."
npm run build

echo "Starting Voice Agent Console (default http://127.0.0.1:533; see server output for the actual listener)..."
exec npm start
