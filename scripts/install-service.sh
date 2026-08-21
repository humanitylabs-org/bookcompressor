#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/bookcompressor.service"
BASE_PATH="${NEXT_PUBLIC_BASE_PATH:-${BOOK_COMPRESSOR_BASE_PATH:-/bookcompressor}}"
PORT="${BOOK_COMPRESSOR_PORT:-3000}"
HOST="${BOOK_COMPRESSOR_HOST:-127.0.0.1}"
INFERENCE_PROVIDER="${BOOK_COMPRESSOR_INFERENCE_PROVIDER:-hermes}"
NPM_BIN="$(command -v npm)"
HERMES_BIN="$(command -v "${BOOK_COMPRESSOR_HERMES_BIN:-hermes}")"
PATH_VALUE="$(dirname "$HERMES_BIN"):$(dirname "$NPM_BIN"):/usr/local/bin:/usr/bin:/bin"

if [[ -e /etc/systemd/system/bookcompressor.service ]]; then
  echo "A system-wide bookcompressor.service already exists."
  echo "Stop here so it can be reviewed or removed explicitly before installing the user service."
  exit 1
fi

if command -v loginctl >/dev/null 2>&1; then
  if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != "yes" ]]; then
    echo "User lingering is disabled; the service would not survive logout/reboot."
    echo "Suggested fix (may require approval): sudo loginctl enable-linger $USER"
    exit 1
  fi
fi

mkdir -p "$UNIT_DIR"
if [[ -e "$UNIT_PATH" ]] && ! grep -q '^# Managed by Book Compressor$' "$UNIT_PATH"; then
  echo "Refusing to replace an unmanaged user unit: $UNIT_PATH"
  exit 1
fi

cat > "$UNIT_PATH" <<EOF
# Managed by Book Compressor
[Unit]
Description=Book Compressor Tailnet App
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=HOME=$HOME
Environment=PATH=$PATH_VALUE
Environment=NEXT_PUBLIC_BASE_PATH=$BASE_PATH
Environment=BOOK_COMPRESSOR_PORT=$PORT
Environment=BOOK_COMPRESSOR_HOST=$HOST
Environment=BOOK_COMPRESSOR_INFERENCE_PROVIDER=$INFERENCE_PROVIDER
Environment=BOOK_COMPRESSOR_HERMES_BIN=$HERMES_BIN
ExecStart=$NPM_BIN run start -- --hostname $HOST --port $PORT
Restart=on-failure
RestartSec=8
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable bookcompressor.service >/dev/null
systemctl --user restart bookcompressor.service
systemctl --user is-enabled bookcompressor.service >/dev/null
systemctl --user is-active bookcompressor.service >/dev/null

if command -v curl >/dev/null 2>&1; then
  HEALTH_URL="http://${HOST}:${PORT}${BASE_PATH}/api/health"
  READY=0
  for _attempt in $(seq 1 20); do
    if curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1; then
      READY=1
      break
    fi
    sleep 1
  done
  if [[ "$READY" -ne 1 ]]; then
    echo "Service became active but did not become healthy: $HEALTH_URL"
    systemctl --user status bookcompressor.service --no-pager --full || true
    exit 1
  fi
fi

echo "✅ user systemd ready: bookcompressor.service (enabled + active, linger enabled)"
