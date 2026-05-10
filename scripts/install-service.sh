#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_PATH="/etc/systemd/system/bookcompressor.service"

cat > "$UNIT_PATH" <<EOF
[Unit]
Description=Book Compressor Tailnet App
After=network-online.target tailscaled.service openclaw-gateway.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
Environment=NEXT_PUBLIC_BASE_PATH=/bookcompressor
ExecStart=/bin/bash -lc 'if [ ! -f .next/BUILD_ID ]; then npm run build; fi; exec npm run start -- --hostname 127.0.0.1 --port 3000'
Restart=always
RestartSec=8

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable bookcompressor.service >/dev/null
systemctl restart bookcompressor.service
systemctl is-enabled bookcompressor.service >/dev/null
systemctl is-active bookcompressor.service >/dev/null

echo "✅ systemd ready: bookcompressor.service (enabled + active)"
