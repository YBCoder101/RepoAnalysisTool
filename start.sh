#!/usr/bin/env bash
# RAT - Repo Analysis Tool
# Usage: ./start.sh   (then open http://localhost:3000)
set -e
cd "$(dirname "$0")"

echo "[RAT] Installing dependencies (npm install)..."
npm install --no-audit --no-fund

echo "[RAT] Starting server: http://localhost:${PORT:-3000}"
exec npm start
