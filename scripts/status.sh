#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$APP_DIR/.runtime"
PID_FILE="$RUNTIME_DIR/bookcompressor.pid"
LOG_FILE="$RUNTIME_DIR/bookcompressor.log"

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$PID" ]] && kill -0 "$PID" 2>/dev/null; then
    echo "Book Compressor is running (PID $PID)."
  else
    echo "PID file exists but process is not running."
  fi
else
  echo "Book Compressor is not running."
fi

if [[ -f "$LOG_FILE" ]]; then
  echo
  echo "Last 20 log lines:"
  tail -n 20 "$LOG_FILE"
fi

