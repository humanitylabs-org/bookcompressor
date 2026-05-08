#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

if [[ "${BOOK_COMPRESSOR_SKIP_PREREQ_CHECK:-0}" != "1" ]]; then
  echo "Running prerequisite check..."
  if ! ./scripts/prereq-check.sh; then
    echo
    echo "Install halted: prerequisites are missing."
    echo "Have your AI fix one required item at a time, then rerun:"
    echo "  ./scripts/prereq-check.sh"
    echo "When all required checks pass, rerun install:"
    echo "  ./scripts/install.sh"
    exit 1
  fi
  echo
fi

echo "Installing dependencies..."
npm install
echo "Done."
