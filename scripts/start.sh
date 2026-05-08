#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$APP_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/bookcompressor.pid"
LOG_FILE="$RUNTIME_DIR/bookcompressor.log"

mkdir -p "$RUNTIME_DIR"

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
HOST="${BOOK_COMPRESSOR_HOST:-127.0.0.1}"
PORT="${BOOK_COMPRESSOR_PORT:-3000}"
MODE="${BOOK_COMPRESSOR_MODE:-prod}" # prod | dev

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "Book Compressor already running (PID $EXISTING_PID)."
    exit 0
  fi
  rm -f "$PID_FILE"
fi

cd "$APP_DIR"
export NEXT_PUBLIC_BASE_PATH="$BASE_PATH"

if [[ "$MODE" == "prod" ]]; then
  echo "Building for production..."
  npm run build
  CMD=(npm run start -- --hostname "$HOST" --port "$PORT")
else
  CMD=(npm run dev -- --hostname "$HOST" --port "$PORT")
fi

echo "Starting Book Compressor ($MODE) on http://$HOST:$PORT${BASE_PATH:-/}"
nohup "${CMD[@]}" >>"$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" >"$PID_FILE"

sleep 1
if kill -0 "$PID" 2>/dev/null; then
  echo "Started (PID $PID). Logs: $LOG_FILE"
else
  echo "Failed to start. Check logs: $LOG_FILE"
  exit 1
fi

