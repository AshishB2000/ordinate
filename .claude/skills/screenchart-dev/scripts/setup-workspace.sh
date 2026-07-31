#!/usr/bin/env bash
#
# One-command bootstrap for a fresh clone of Screenchart. Runs from any directory.
#
#   bash .claude/skills/screenchart-dev/scripts/setup-workspace.sh
set -euo pipefail

# This script's own dir (to call sibling scripts) + the repo root (for npm).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "→ Checking prerequisites…"
bash "$SCRIPT_DIR/check-prereqs.sh"

echo
echo "→ Installing dependencies (npm install)…"
npm install   # runs postinstall (scripts/download-geo.js) too

# Git hooks: this repo doesn't use husky or committed hooks. If that changes
# (a .husky/ dir or a package.json "prepare" script appears), wire it here.
if [ -d .husky ]; then
  echo "→ Installing git hooks (husky)…"
  npx husky install
  echo "✓ git hooks installed"
else
  echo "✓ no git hooks configured (nothing to set up)"
fi

echo
echo "✓ Ready. Next:"
echo "    npm start          # run the app"
echo "    npm test           # self-checks"
echo "    npm run dist:mac    # build a macOS installer"
