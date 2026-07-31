#!/usr/bin/env bash
#
# Open a PR from the current branch into main. Does NOT merge. Runs from any directory.
#
#   bash .claude/skills/screenchart-dev/scripts/create-pr.sh                       # gh fills title/body from commits
#   bash .claude/skills/screenchart-dev/scripts/create-pr.sh "Title" "Body text"    # explicit title + body
#   bash .claude/skills/screenchart-dev/scripts/create-pr.sh --title "T" --body "B" # or pass gh flags through
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

BASE=main
branch="$(git rev-parse --abbrev-ref HEAD)"

if [ "$branch" = "$BASE" ]; then
  echo "✗ You're on '$BASE'. Switch to a feature branch first (git checkout -b feat/…)."
  exit 1
fi

echo "→ Pushing '$branch' to origin…"
git push -u origin "$branch"
echo "✓ pushed"

echo "→ Opening PR into '$BASE'…"
if [ "$#" -eq 0 ]; then
  # No args: let gh derive the title/body from the commits.
  gh pr create --base "$BASE" --head "$branch" --fill
elif [ "$#" -eq 2 ] && [ "${1#--}" = "$1" ]; then
  # Two plain args → title + body (positional convenience).
  gh pr create --base "$BASE" --head "$branch" --title "$1" --body "$2"
else
  # Otherwise pass everything through to gh (e.g. --title/--body/--label…).
  gh pr create --base "$BASE" --head "$branch" "$@"
fi

echo
echo "→ PR URL:"
gh pr view --json url -q .url
