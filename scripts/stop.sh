#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_FILE="$APP_DIR/.runtime/bookcompressor.pid"

if [[ ! -f "$PID_FILE" ]]; then
  echo "No PID file found. Book Compressor may already be stopped."
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -z "$PID" ]]; then
  rm -f "$PID_FILE"
  echo "PID file was empty. Cleaned up."
  exit 0
fi

if kill -0 "$PID" 2>/dev/null; then
  echo "Stopping PID $PID..."
  kill "$PID"
  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    echo "Process still running, sending SIGKILL..."
    kill -9 "$PID"
  fi
else
  echo "Process $PID is not running."
fi

rm -f "$PID_FILE"
echo "Stopped."

