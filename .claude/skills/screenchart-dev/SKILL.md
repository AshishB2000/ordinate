---
name: screenchart-dev
description: Use when working on the Screenchart repo — setting up the dev environment, checking build prerequisites (Node/npm/gh/electron-builder), opening a pull request into main, or filing a GitHub issue. Provides the helper scripts and the repo's branch/PR workflow so every change follows it.
---

# Screenchart dev workflow

Helper scripts and the standing workflow for developing Screenchart
(`AshishB2000/screenchart`). The scripts are location-independent — they resolve
the repo root themselves, so they run from any directory.

## Standing workflow — follow this for every change

1. **Never commit to `main`.** Every code change goes on a NEW branch off an
   up-to-date `main` (`fix/<short-name>` for a bugfix, `feat/<short-name>` for a
   feature), or reuse an existing branch that's already for that work.
   ```bash
   git checkout main && git pull
   git checkout -b fix/<short-name>
   ```
2. **Confirm before committing.** Show the proposed commit message (title + 1–3
   line body) and wait for the user's approval before running `git commit`. Do
   not add a `Co-Authored-By: Claude` trailer.
3. **Open the PR with `create-pr.sh`.** It pushes the branch and opens a PR into
   `main`; it refuses to run on `main`.
4. **Never merge.** The user reviews and merges. `main` is protected (PR
   required), so a PR that shows "blocked until reviewed" is expected, not an
   error.

## Scripts

Run any of them directly, or let them run as part of the flow above.

| Script | What it does | When to use |
|--------|--------------|-------------|
| `scripts/check-prereqs.sh` | Verifies the build environment: Node 18+, npm, `gh` installed **and** authenticated, electron-builder. Prints ✓/✗ per check; exits non-zero if any required check fails. | Before a build, or to diagnose "why won't it build/PR". |
| `scripts/setup-workspace.sh` | Bootstraps a fresh clone: runs the prereq check, `npm install` (which runs `postinstall`/`download-geo.js`), then prints next steps. | Right after cloning, or after dependency changes. |
| `scripts/create-pr.sh` | Pushes the current branch and opens a PR into `main` via `gh`. Refuses on `main`. Does **not** merge. | Step 3 of the workflow — after commits are approved and made. |
| `scripts/create-issue.sh` | Opens a GitHub issue in `AshishB2000/screenchart` via `gh`. | To file a bug/task from the terminal. |

### Usage

```bash
bash .claude/skills/screenchart-dev/scripts/check-prereqs.sh
bash .claude/skills/screenchart-dev/scripts/setup-workspace.sh
bash .claude/skills/screenchart-dev/scripts/create-pr.sh                        # gh fills title/body from commits
bash .claude/skills/screenchart-dev/scripts/create-pr.sh "Title" "Body"          # or an explicit title + body
bash .claude/skills/screenchart-dev/scripts/create-issue.sh "Title" "Body" --label bug
```

`create-pr.sh` and `create-issue.sh` need the [`gh` CLI](https://cli.github.com/)
authenticated (`gh auth login`) — `check-prereqs.sh` verifies this.
