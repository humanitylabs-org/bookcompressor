#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

if ! git remote get-url upstream >/dev/null 2>&1; then
  cat <<'EOF'
No upstream remote is configured.

Example:
  git remote add upstream https://github.com/humanitylabs-org/book-compressor.git
EOF
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
UPSTREAM_BRANCH="${UPSTREAM_BRANCH:-main}"

echo "Fetching upstream..."
git fetch upstream

echo "Merging upstream/$UPSTREAM_BRANCH into $CURRENT_BRANCH..."
git merge --no-edit "upstream/$UPSTREAM_BRANCH"

echo "Done. Review changes, run tests, then push your fork."

