#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"
DEFAULT_UPSTREAM_URL="https://github.com/humanitylabs-org/bookcompressor.git"

if ! git diff --quiet || ! git diff --cached --quiet; then
  cat <<'EOF'
Working tree has uncommitted changes.

Commit or stash first, then re-run update.
EOF
  exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  ORIGIN_URL="$(git remote get-url origin 2>/dev/null || true)"

  if [[ "$ORIGIN_URL" == *"humanitylabs-org/bookcompressor.git"* ]]; then
    echo "Origin points at humanitylabs-org/bookcompressor. Pulling latest main from origin..."
    git pull --ff-only origin "$UPSTREAM_BRANCH"
    echo "Done. Restart with ./scripts/start.sh"
    exit 0
  fi

  cat <<EOF
No upstream remote is configured.

If this is your fork, run:
  git remote add upstream ${DEFAULT_UPSTREAM_URL}

Then re-run this script.
EOF
  exit 1
fi

echo "Fetching upstream..."
git fetch upstream

echo "Merging upstream/$UPSTREAM_BRANCH into $CURRENT_BRANCH..."
git merge --no-edit "upstream/$UPSTREAM_BRANCH"

echo "Done. Review changes, run tests, then push your fork."
