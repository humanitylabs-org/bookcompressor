#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$APP_DIR/.runtime"
REPORT_FILE="$RUNTIME_DIR/prereq-report.txt"
ENV_FILE="$RUNTIME_DIR/bookcompressor.env"
mkdir -p "$RUNTIME_DIR"

# shellcheck disable=SC1090
if [[ -f "$ENV_FILE" ]]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

FAIL=0
WARN=0

declare -a FAIL_ITEMS=()
declare -a WARN_ITEMS=()
declare -a FIX_ITEMS=()

ok() { echo "✅ $1"; }
warn() { echo "⚠️  $1"; WARN=1; WARN_ITEMS+=("$1"); }
fail() {
  local message="$1"
  local fix="${2:-}"
  echo "❌ $message"
  FAIL=1
  FAIL_ITEMS+=("$message")
  [[ -n "$fix" ]] && FIX_ITEMS+=("$message|||$fix")
}
note() { echo "   ↳ $1"; }

print_fix_hints() {
  [[ "${#FIX_ITEMS[@]}" -eq 0 ]] && return
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

normalize_provider() {
  local raw="${1:-auto}"
  raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr '_' '-')"
  case "$raw" in
    hermes|openclaw|openrouter|auto) echo "$raw" ;;
    command|custom|agent|agent-command) echo "agent-command" ;;
    *) echo "auto" ;;
  esac
}

has_openrouter_key() {
  [[ -n "${OPENROUTER_API_KEY:-${OPENROUTER_KEY:-${OPENROUTER_API_TOKEN:-${AI_API_KEY:-${LLM_API_KEY:-}}}}}" ]]
}

smoke_hermes() {
  command -v hermes >/dev/null 2>&1 || return 2
  echo "- running Hermes model smoke test..."
  local out
  local -a args=(chat -q 'Reply with exactly: smoke-ok' -Q --ignore-rules --max-turns 1 --source bookcompressor-prereq)
  if [[ -n "${BOOK_COMPRESSOR_HERMES_PROVIDER:-}" ]]; then
    args+=(--provider "$BOOK_COMPRESSOR_HERMES_PROVIDER")
  fi
  if command -v timeout >/dev/null 2>&1; then
    out="$(timeout 120 hermes "${args[@]}" 2>/dev/null)" || return 1
  else
    out="$(hermes "${args[@]}" 2>/dev/null)" || return 1
  fi
  printf '%s' "$out" | grep -qi 'smoke-ok'
}

smoke_openclaw() {
  command -v openclaw >/dev/null 2>&1 || return 2
  echo "- running OpenClaw model smoke test..."
  local out
  if command -v timeout >/dev/null 2>&1; then
    out="$(timeout 60 openclaw capability model run --gateway --json --prompt 'Reply with exactly: smoke-ok' 2>/dev/null)" || return 1
  else
    out="$(openclaw capability model run --gateway --json --prompt 'Reply with exactly: smoke-ok' 2>/dev/null)" || return 1
  fi
  printf '%s' "$out" | grep -qi 'smoke-ok'
}

check_agent_command() {
  if [[ -z "${BOOK_COMPRESSOR_AGENT_COMMAND:-}" ]]; then
    return 2
  fi
  command -v "$BOOK_COMPRESSOR_AGENT_COMMAND" >/dev/null 2>&1 || [[ -x "$BOOK_COMPRESSOR_AGENT_COMMAND" ]]
}

check_inference_provider() {
  local provider="$1"
  echo "Inference provider: $provider"

  case "$provider" in
    hermes)
      if smoke_hermes; then ok "Hermes model call succeeded"; else fail "Hermes model call failed" $'Try:\n  hermes doctor\n  hermes chat -q "Reply with exactly: smoke-ok" -Q\nOr choose another runtime:\n  ./scripts/agent-select.sh --force'; fi
      ;;
    openclaw)
      if smoke_openclaw; then ok "OpenClaw model call succeeded"; else fail "OpenClaw model call failed" $'Try:\n  openclaw status\n  openclaw gateway restart\nOr choose another runtime:\n  ./scripts/agent-select.sh --force'; fi
      ;;
    openrouter)
      if has_openrouter_key; then ok "OpenRouter API key found"; else fail "OpenRouter API key not configured" $'Set one of:\n  OPENROUTER_API_KEY\n  OPENROUTER_KEY\n  OPENROUTER_API_TOKEN\nOr choose another runtime:\n  ./scripts/agent-select.sh --force'; fi
      ;;
    agent-command)
      if check_agent_command; then ok "custom agent command found: ${BOOK_COMPRESSOR_AGENT_COMMAND}"; else fail "custom agent command not configured or not executable" $'Set:\n  BOOK_COMPRESSOR_AGENT_COMMAND\n  BOOK_COMPRESSOR_AGENT_ARGS\nOr run:\n  ./scripts/agent-select.sh --force'; fi
      ;;
    auto)
      if [[ -n "${BOOK_COMPRESSOR_AGENT_COMMAND:-}" ]] && check_agent_command; then
        ok "custom agent command available: ${BOOK_COMPRESSOR_AGENT_COMMAND}"
      elif smoke_hermes; then
        ok "Hermes model call succeeded"
      elif smoke_openclaw; then
        ok "OpenClaw model call succeeded"
      elif has_openrouter_key; then
        ok "OpenRouter API key found"
      else
        fail "no usable inference provider detected" $'Preferred fix on Hermes VPS:\n  hermes doctor\n  hermes chat -q "Reply with exactly: smoke-ok" -Q\nThen choose Hermes:\n  ./scripts/agent-select.sh --force\nAlternatives: configure OpenClaw, OpenRouter, or BOOK_COMPRESSOR_AGENT_COMMAND.'
      fi
      ;;
  esac
}

echo "Book Compressor prerequisite check"
echo "Report file: $REPORT_FILE"
echo

exec > >(tee "$REPORT_FILE") 2>&1

if command -v tailscale >/dev/null 2>&1; then
  ok "tailscale CLI found"
else
  fail "tailscale CLI not found" $'Install Tailscale first:\n- https://tailscale.com/download\nLinux quick path (needs approval):\n  curl -fsSL https://tailscale.com/install.sh | sh'
fi

if command -v tailscale >/dev/null 2>&1; then
  if tailscale status >/dev/null 2>&1; then ok "Tailscale daemon reachable"; else fail "Tailscale daemon not reachable or not authenticated" $'Try:\n  tailscale up\nIf tailscaled service is stopped (Linux/systemd):\n  sudo systemctl enable --now tailscaled'; fi
  if tailscale serve status >/dev/null 2>&1; then ok "tailscale serve is available"; else fail "tailscale serve is not ready on this tailnet/device" $'Try:\n  tailscale serve 3000\nThen follow any HTTPS/consent prompt once, and re-run this check.'; fi
fi

if command -v git >/dev/null 2>&1; then ok "git found: $(git --version)"; else fail "git is not installed" $'Install git, then re-run this check.\nDebian/Ubuntu (needs approval):\n  sudo apt-get update && sudo apt-get install -y git'; fi

if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node -v)"
  ok "node found: ${NODE_VERSION}"
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]' 2>/dev/null || echo 0)"
  if (( NODE_MAJOR < 20 )) || (( NODE_MAJOR == 20 && NODE_MINOR < 9 )); then
    fail "node ${NODE_VERSION} is too old (Next.js 16 requires >= 20.9)" $'Upgrade Node.js to >= 20.9 and re-run this check.\nIf you use nvm:\n  nvm install 22\n  nvm use 22'
  fi
else
  fail "node is not installed" $'Install Node.js >= 20.9, then re-run this check.'
fi

if command -v npm >/dev/null 2>&1; then ok "npm found: $(npm -v)"; else fail "npm is not installed" $'Install npm (usually bundled with Node.js), then re-run this check.'; fi

PROVIDER="$(normalize_provider "${BOOK_COMPRESSOR_INFERENCE_PROVIDER:-auto}")"
check_inference_provider "$PROVIDER"

PORT="${BOOK_COMPRESSOR_PORT:-3000}"
if command -v ss >/dev/null 2>&1; then
  if ss -ltn | grep -q ":${PORT} "; then warn "port ${PORT} appears to already be in use"; note "Set a different port, e.g.: export BOOK_COMPRESSOR_PORT=3012"; else ok "port ${PORT} appears available"; fi
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
[[ "$WARN" -ne 0 ]] && echo "Warnings: ${#WARN_ITEMS[@]}"
