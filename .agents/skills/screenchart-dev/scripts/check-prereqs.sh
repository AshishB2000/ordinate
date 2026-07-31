#!/usr/bin/env bash
#
# Verify the dev/build environment for Screenchart. Reusable by the other
# scripts — source it or run it directly. Prints a ✓/✗ per check and exits
# non-zero if any REQUIRED check fails. Runs from any directory.
#
#   bash .claude/skills/screenchart-dev/scripts/check-prereqs.sh
set -euo pipefail

# Run from the repo root regardless of the caller's CWD (the electron-builder
# check below resolves node_modules relative to it).
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# Minimum Node major. No .nvmrc / package.json "engines" in this repo, so the
# README ("Node.js 18+") is the source of truth. Bump both together if it moves.
MIN_NODE_MAJOR=18

fail=0
ok()   { printf '✓ %s\n' "$1"; }
bad()  { printf '✗ %s\n' "$1"; fail=1; }

# Node present + major version high enough.
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$node_major" -ge "$MIN_NODE_MAJOR" ]; then
    ok "Node $(node -v) (>= ${MIN_NODE_MAJOR})"
  else
    bad "Node $(node -v) is too old — need >= ${MIN_NODE_MAJOR} (see README)"
  fi
else
  bad "Node not found — install from https://nodejs.org/"
fi

# npm present.
if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm -v)"
else
  bad "npm not found (ships with Node)"
fi

# gh CLI installed AND authenticated.
if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    ok "gh $(gh --version | head -1 | awk '{print $3}') — authenticated"
  else
    bad "gh installed but NOT authenticated — run: gh auth login"
  fi
else
  bad "gh not found — run: brew install gh && gh auth login"
fi

# electron-builder available (dev builds). Prefer the locally-installed binary.
if [ -x node_modules/.bin/electron-builder ]; then
  ok "electron-builder $(node_modules/.bin/electron-builder --version 2>/dev/null || echo '?') (node_modules)"
elif node -e "require.resolve('electron-builder')" >/dev/null 2>&1; then
  ok "electron-builder resolvable"
else
  bad "electron-builder not installed — run: npm install"
fi

if [ "$fail" -ne 0 ]; then
  printf '\nSome required checks failed.\n'
  exit 1
fi
printf '\nAll prerequisite checks passed.\n'
