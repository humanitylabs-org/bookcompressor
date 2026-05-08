#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$APP_DIR/.runtime"
REPORT_FILE="$RUNTIME_DIR/prereq-report.txt"
mkdir -p "$RUNTIME_DIR"

FAIL=0
WARN=0

declare -a FAIL_ITEMS=()
declare -a WARN_ITEMS=()
declare -a FIX_ITEMS=()

ok() {
  echo "✅ $1"
}

warn() {
  echo "⚠️  $1"
  WARN=1
  WARN_ITEMS+=("$1")
}

fail() {
  local message="$1"
  local fix="${2:-}"
  echo "❌ $message"
  FAIL=1
  FAIL_ITEMS+=("$message")
  if [[ -n "$fix" ]]; then
    FIX_ITEMS+=("$message|||$fix")
  fi
}

note() {
  echo "   ↳ $1"
}

print_fix_hints() {
  if [[ "${#FIX_ITEMS[@]}" -eq 0 ]]; then
    return
  fi

  echo
  echo "Suggested safe fixes"
  echo "--------------------"
  local i=1
  for item in "${FIX_ITEMS[@]}"; do
    local issue="${item%%|||*}"
    local fix="${item#*|||}"
    echo "${i}) ${issue}"
    while IFS= read -r line; do
      [[ -n "$line" ]] && echo "   $line"
    done <<<"$fix"
    echo
    i=$((i + 1))
  done

  cat <<'EOF'
Safe remediation loop for AI-guided installs:
- Fix one required issue at a time.
- Re-run: ./scripts/prereq-check.sh
- Repeat until all required checks pass.
- For sudo/package-manager commands, ask user approval before executing.
EOF
}

echo "Book Compressor prerequisite check"
echo "Report file: $REPORT_FILE"
echo

# Save full output to report file while still printing to terminal.
exec > >(tee "$REPORT_FILE") 2>&1

if command -v tailscale >/dev/null 2>&1; then
  ok "tailscale CLI found"
else
  fail "tailscale CLI not found" $'Install Tailscale first:\n- https://tailscale.com/download\nLinux quick path (needs approval):\n  curl -fsSL https://tailscale.com/install.sh | sh'
fi

if command -v tailscale >/dev/null 2>&1; then
  if tailscale status >/dev/null 2>&1; then
    ok "Tailscale daemon reachable"
  else
    fail "Tailscale daemon not reachable or not authenticated" $'Try:\n  tailscale up\nIf tailscaled service is stopped (Linux/systemd):\n  sudo systemctl enable --now tailscaled'
  fi

  if tailscale serve status >/dev/null 2>&1; then
    ok "tailscale serve is available"
  else
    fail "tailscale serve is not ready on this tailnet/device" $'Try:\n  tailscale serve 3000\nThen follow any HTTPS/consent prompt once, and re-run this check.'
  fi
fi

if command -v git >/dev/null 2>&1; then
  ok "git found: $(git --version)"
else
  fail "git is not installed" $'Install git, then re-run this check.\nDebian/Ubuntu (needs approval):\n  sudo apt-get update && sudo apt-get install -y git'
fi

NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node -v)"
  ok "node found: ${NODE_VERSION}"
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"
  if (( NODE_MAJOR < 20 )) || (( NODE_MAJOR == 20 && NODE_MINOR < 9 )); then
    fail "node ${NODE_VERSION} is too old (Next.js 16 requires >= 20.9)" $'Upgrade Node.js to >= 20.9 and re-run this check.\nIf you use nvm:\n  nvm install 22\n  nvm use 22'
  else
    NODE_OK=1
  fi
else
  fail "node is not installed" $'Install Node.js >= 20.9, then re-run this check.'
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm found: $(npm -v)"
else
  fail "npm is not installed" $'Install npm (usually bundled with Node.js), then re-run this check.'
fi

if command -v openclaw >/dev/null 2>&1; then
  ok "openclaw CLI found"
else
  fail "openclaw CLI not found" $'Install OpenClaw on this host, then verify:\n  openclaw status'
fi

if command -v openclaw >/dev/null 2>&1; then
  echo "- running OpenClaw model smoke test..."
  if command -v timeout >/dev/null 2>&1; then
    SMOKE_CMD=(timeout 60 openclaw capability model run --gateway --json --prompt 'Reply with exactly: smoke-ok')
  else
    SMOKE_CMD=(openclaw capability model run --gateway --json --prompt 'Reply with exactly: smoke-ok')
  fi

  if out="$("${SMOKE_CMD[@]}" 2>/dev/null)"; then
    if printf '%s' "$out" | grep -qi 'smoke-ok'; then
      ok "OpenClaw gateway model call succeeded"
    else
      fail "OpenClaw gateway responded but smoke text was not returned" $'Check model/provider configuration, then test manually:\n  openclaw capability model run --gateway --prompt "Reply with exactly: smoke-ok"'
    fi
  else
    fail "OpenClaw gateway model call failed" $'Try:\n  openclaw status\n  openclaw gateway restart\nThen re-run this check.'
  fi
fi

PORT="${BOOK_COMPRESSOR_PORT:-3000}"
if command -v ss >/dev/null 2>&1; then
  if ss -ltn | grep -q ":${PORT} "; then
    warn "port ${PORT} appears to already be in use"
    note "Set a different port, e.g.: export BOOK_COMPRESSOR_PORT=3012"
  else
    ok "port ${PORT} appears available"
  fi
else
  warn "could not verify port usage (ss not found)"
fi

echo
if [[ "$FAIL" -ne 0 ]]; then
  echo "Prerequisite check failed (${#FAIL_ITEMS[@]} required issue(s))."
  print_fix_hints
  exit 1
fi

echo "All required checks passed."
if [[ "$WARN" -ne 0 ]]; then
  echo "Warnings: ${#WARN_ITEMS[@]}"
fi
