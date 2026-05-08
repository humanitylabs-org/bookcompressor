#!/usr/bin/env bash
set -euo pipefail

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale CLI not found on PATH."
  exit 1
fi

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

PORT="${BOOK_COMPRESSOR_PORT:-3000}"
BASE_PATH="$(normalize_base_path "${NEXT_PUBLIC_BASE_PATH:-${BOOK_COMPRESSOR_BASE_PATH:-/bookcompressor}}")"

if [[ -z "$BASE_PATH" ]]; then
  echo "Base path cannot be empty for Tailscale path serving."
  exit 1
fi

TARGET="http://127.0.0.1:${PORT}${BASE_PATH}"

echo "Configuring Tailscale Serve path: ${BASE_PATH} -> ${TARGET}"
tailscale serve --bg --https=443 --set-path="$BASE_PATH" "$TARGET"

echo
echo "Done. Open: https://<this-device>.ts.net${BASE_PATH}"

