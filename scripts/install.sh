#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

if [[ "${BOOK_COMPRESSOR_SKIP_PREREQ_CHECK:-0}" != "1" ]]; then
  echo "Running prerequisite check..."
  ./scripts/prereq-check.sh
  echo
fi

echo "Installing dependencies..."
npm install
echo "Done."
