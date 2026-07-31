#!/usr/bin/env bash
#
# Open a GitHub issue in AshishB2000/screenchart. Runs from any directory.
#
#   bash .claude/skills/screenchart-dev/scripts/create-issue.sh "Title"                     # title only
#   bash .claude/skills/screenchart-dev/scripts/create-issue.sh "Title" "Body text"          # title + body
#   bash .claude/skills/screenchart-dev/scripts/create-issue.sh "Title" "Body" --label bug   # + a label
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

REPO=AshishB2000/screenchart

if [ "$#" -lt 1 ] || [ -z "${1:-}" ]; then
  echo "✗ Title is required."
  echo "  Usage: bash .claude/skills/screenchart-dev/scripts/create-issue.sh \"Title\" [\"Body\"] [--label <name>]"
  exit 1
fi

title="$1"; shift

# Optional positional body (only if the next arg isn't a flag).
body=""
if [ "$#" -gt 0 ] && [ "${1#--}" = "$1" ]; then
  body="$1"; shift
fi

echo "→ Creating issue in $REPO…"
url="$(gh issue create --repo "$REPO" --title "$title" --body "$body" "$@")"

echo "✓ Issue created:"
echo "$url"
