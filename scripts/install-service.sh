#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME="bookcompressor.service"
ENV_FILE="$APP_DIR/.runtime/bookcompressor.env"
mkdir -p "$APP_DIR/.runtime"

if [[ ! -f "$ENV_FILE" ]]; then
  "$APP_DIR/scripts/agent-select.sh"
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found. Use ./scripts/start.sh or create a macOS launchd agent instead."
  exit 1
fi

install_user_service() {
  local unit_dir="$HOME/.config/systemd/user"
  local unit_path="$unit_dir/$UNIT_NAME"
  mkdir -p "$unit_dir"
  cat >"$unit_path" <<EOF
[Unit]
Description=Book Compressor Tailnet App
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=NEXT_PUBLIC_BASE_PATH=/bookcompressor
EnvironmentFile=-$ENV_FILE
ExecStartPre=/bin/bash -lc 'test -f .next/BUILD_ID || npm run build'
ExecStart=/bin/bash -lc 'exec npm run start -- --hostname "\${BOOK_COMPRESSOR_HOST:-127.0.0.1}" --port "\${BOOK_COMPRESSOR_PORT:-3000}"'
Restart=always
RestartSec=8

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$UNIT_NAME" >/dev/null
  systemctl --user restart "$UNIT_NAME"
  systemctl --user is-enabled "$UNIT_NAME" >/dev/null
  systemctl --user is-active "$UNIT_NAME" >/dev/null
  echo "✅ systemd user service ready: $UNIT_NAME (enabled + active)"
}

install_system_service() {
  local service_user="${BOOK_COMPRESSOR_SERVICE_USER:-${SUDO_USER:-$(id -un)}}"
  local unit_path="/etc/systemd/system/$UNIT_NAME"
  cat >"$unit_path" <<EOF
[Unit]
Description=Book Compressor Tailnet App
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=$service_user
WorkingDirectory=$APP_DIR
Environment=NEXT_PUBLIC_BASE_PATH=/bookcompressor
EnvironmentFile=-$ENV_FILE
ExecStartPre=/bin/bash -lc 'test -f .next/BUILD_ID || npm run build'
ExecStart=/bin/bash -lc 'exec npm run start -- --hostname "\${BOOK_COMPRESSOR_HOST:-127.0.0.1}" --port "\${BOOK_COMPRESSOR_PORT:-3000}"'
Restart=always
RestartSec=8

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$UNIT_NAME" >/dev/null
  systemctl restart "$UNIT_NAME"
  systemctl is-enabled "$UNIT_NAME" >/dev/null
  systemctl is-active "$UNIT_NAME" >/dev/null
  echo "✅ systemd system service ready: $UNIT_NAME (enabled + active as $service_user)"
}

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  install_system_service
else
  install_user_service
fi
