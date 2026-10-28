---
name: feature-branch-workflow
description: Use when starting new work in the Ordinate repo, or when about to branch, commit, push, open a pull request, merge, or clean up a worktree after a merge.
---

# Feature branch workflow

The trunk is **`develop`**. Every change gets its own worktree off `origin/develop`, then a PR to
`develop`, then CI green, then merge, then the worktree is removed. CLAUDE.md's **Git** section
is the rule; this is the exact sequence.

**Never run `git checkout` or `git switch` in the main checkout** (`/Users/…/ordinate` itself).
Other sessions work in that clone at the same time, and moving its branch moves their files.
That has already lost work here. Never commit to `develop` directly; the ruleset refuses a push.

## 1. Start: a worktree off `origin/develop`

```bash
git fetch origin develop
git worktree add --no-track -b fix/short-name .claude/worktrees/short-name origin/develop
```

- Prefixes: `feat/`, `fix/`, `chore/`, `docs/`. One feature or fix per branch.
- `--no-track` matters: under the Claude Code sandbox git cannot write `.git/config`, and without
  it the branch is created but the worktree is not ("could not lock config file"). If that
  happens anyway, finish with `git worktree add .claude/worktrees/short-name fix/short-name`.
- Then enter it (`EnterWorktree` with `path`), or keep working from outside with absolute paths
  and `git -C <worktree>`. A bare `cd <worktree>` moves the session's working directory.
- A new worktree has no `node_modules`. Root: `ln -s <main>/node_modules node_modules`.
  `web/node_modules` must be a real folder of links, not one symlink (Vite writes
  `web/node_modules/.vite-temp/`, which would land in the main checkout):
  `mkdir web/node_modules && ln -s <main>/web/node_modules/* <main>/web/node_modules/.bin web/node_modules/`.
- Start any subagents **after** entering the worktree. A subagent's shell stays where it started.

## 2. Commit

Commit when the user asks. The message says what the change does and why:

```
Read Home's mention project names from the switcher's list

One to three plain lines on what changed and why a reader would care.
```

- Title in the imperative, about 50 characters: "Add X", not "update" or "fix stuff".
- **No `Co-Authored-By` or any AI co-author trailer**, ever (CLAUDE.md).
- Before committing, run what is quick: `npm run lint` (blocking in CI) and the suites you
  touched (`node scripts/test-<name>.js` after `npm run build:ts`). Skip `npm run smoke` and the
  full e2e run locally; CI runs them on the PR.

## 3. Push and open the PR

```bash
git push origin fix/short-name
gh pr create --base develop --head fix/short-name --title "…" --body-file <file>
```

- Push without `-u` (that writes `.git/config`). Under the sandbox, `git push` and `gh` need the
  sandbox off: `gh` keeps its token in the macOS keychain, and a sandboxed `gh auth status`
  reports "token invalid" even when the login is fine.
- The PR body says what changed, why, and how it was checked. If PRs touch the same files, open
  them as a chain and give the merge order in each body. Never open parallel PRs that conflict.
- The PR needs two required checks: **`smoke (all shards)`** and **`oxlint (blocking)`**.
  - **No checks at all** is not passing. It means a stale `branches:` filter or a merge conflict,
    so read `mergeStateStatus`.
  - Checks that fail in seconds with no steps are GitHub billing, not code.

## 4. After the merge

PRs here are often merged fast, sometimes before CI finishes. Before pushing a follow-up
commit, check the PR state (`gh pr view <n> --json state`). If it is merged, start a new
worktree off the new `origin/develop` and open a new PR.

```bash
git -C <main checkout> pull                      # the main checkout stays on develop
git merge-base --is-ancestor fix/short-name origin/develop && echo merged
git worktree remove .claude/worktrees/short-name
git branch -d fix/short-name                     # -d refuses if anything is unmerged
```

`gh pr merge --delete-branch` fails at its local step here (develop is checked out in the
main clone). The merge still lands. Delete the remote branch with
`git push origin --delete fix/short-name`.

## Conflicts

Resolve keeping both sides, then re-check the merged tree (build, lint, the touched suites).
`src/api/index.ts`, `web/src/app/routes.tsx` and `web/src/app/nav.ts` are append-only, so keep
every entry from both sides. One-sided merges have dropped routes and fixes before (#193, #227).

## Quick reference

| Step | Command or rule |
|---|---|
| Start | `git worktree add --no-track -b feat/x .claude/worktrees/x origin/develop` |
| Never | `git checkout` / `git switch` in the main clone; commit to `develop` |
| Commit | imperative title + why; no AI co-author trailer |
| Push | `git push origin feat/x` (no `-u`; sandbox off) |
| PR | `--base develop`; required: `smoke (all shards)`, `oxlint (blocking)` |
| Done | pull develop in the main clone, `git worktree remove`, `git branch -d` |
