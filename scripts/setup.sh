#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

normalize_base_path() {
  local raw="${1:-}"
  raw="${raw#/}"
  raw="${raw%/}"
  if [[ -z "$raw" ]]; then
    echo ""
  else
    echo "/$raw"
  fi
}

BASE_PATH="$(normalize_base_path "${NEXT_PUBLIC_BASE_PATH:-${BOOK_COMPRESSOR_BASE_PATH:-/bookcompressor}}")"
PORT="${BOOK_COMPRESSOR_PORT:-3000}"
HOST="${BOOK_COMPRESSOR_HOST:-127.0.0.1}"

if [[ -z "$BASE_PATH" ]]; then
  echo "Base path cannot be empty."
  exit 1
fi

echo "Step 1/5: prerequisite check"
if ! ./scripts/prereq-check.sh; then
  echo
  echo "Setup paused: fix required prerequisite issues first, then run:"
  echo "  ./scripts/setup.sh"
  exit 1
fi

echo
echo "Step 2/5: install dependencies"
BOOK_COMPRESSOR_SKIP_PREREQ_CHECK=1 ./scripts/install.sh

echo
echo "Step 3/5: start app"
./scripts/start.sh

echo
echo "Step 4/5: expose tailnet path"
./scripts/serve-path.sh

echo
echo "Step 5/6: install/verify systemd auto-start"
./scripts/install-service.sh

echo
echo "Step 6/6: verify health"
if command -v curl >/dev/null 2>&1; then
  HEALTH_URL="http://${HOST}:${PORT}${BASE_PATH}/api/health"
  if curl -fsS "$HEALTH_URL" >/dev/null; then
    echo "✅ Health check passed: ${HEALTH_URL}"
  else
    echo "⚠️  Health check failed: ${HEALTH_URL}"
  fi
else
  echo "⚠️  curl not found, skipped health check"
fi

echo
echo "Setup complete."
echo "Open: https://<this-device>.ts.net${BASE_PATH}"
