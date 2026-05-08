#!/usr/bin/env bash
set -euo pipefail

FAIL=0

ok() {
  echo "✅ $1"
}

warn() {
  echo "⚠️  $1"
}

fail() {
  echo "❌ $1"
  FAIL=1
}

echo "Book Compressor prerequisite check"
echo

if command -v tailscale >/dev/null 2>&1; then
  ok "tailscale CLI found"
else
  fail "tailscale CLI not found"
fi

if command -v tailscale >/dev/null 2>&1; then
  if tailscale status >/dev/null 2>&1; then
    ok "Tailscale daemon reachable"
  else
    fail "Tailscale daemon not reachable (try: tailscale up)"
  fi
fi

if command -v node >/dev/null 2>&1; then
  ok "node found: $(node -v)"
else
  fail "node is not installed"
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm found: $(npm -v)"
else
  fail "npm is not installed"
fi

if command -v openclaw >/dev/null 2>&1; then
  ok "openclaw CLI found"
else
  fail "openclaw CLI not found"
fi

if command -v openclaw >/dev/null 2>&1; then
  echo "- running OpenClaw model smoke test..."
  if out="$(openclaw capability model run --gateway --json --prompt 'Reply with exactly: smoke-ok' 2>/dev/null)"; then
    if printf '%s' "$out" | grep -qi 'smoke-ok'; then
      ok "OpenClaw gateway model call succeeded"
    else
      fail "OpenClaw gateway responded but smoke text was not returned"
    fi
  else
    fail "OpenClaw gateway model call failed"
  fi
fi

PORT="${BOOK_COMPRESSOR_PORT:-3000}"
if command -v ss >/dev/null 2>&1; then
  if ss -ltn | grep -q ":${PORT} "; then
    warn "port ${PORT} appears to already be in use (set BOOK_COMPRESSOR_PORT to another port if needed)"
  else
    ok "port ${PORT} appears available"
  fi
fi

echo
if [[ "$FAIL" -ne 0 ]]; then
  echo "Prerequisite check failed. Fix items above before install/start."
  exit 1
fi

echo "All required checks passed."

