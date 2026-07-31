---
name: feature-branch-workflow
description: Use when starting new work in this repo, or when about to commit, save, or push changes to git.
---

# Feature Branch Workflow

## Overview

New work goes on its own branch, and every commit gets a clear title and a short
description. **Never commit straight to `main`.**

## Step 1 — Branch before starting work

One feature or fix = one branch. Branch from an up-to-date `main`:

```bash
git checkout main && git pull
git checkout -b feature/<short-name>   # use fix/<short-name> for a bugfix
```

Names are short and descriptive: `feature/region-select-overlay`, `fix/misread-digits`.

## Step 2 — Commit with a good message

Format:

```
Short imperative title (~50 chars max)

1–3 plain-language lines on WHAT changed and WHY.
```

- Title says what the change *does*: "Add region-select overlay" — not "update" or "fix stuff".
- Body explains the reasoning a future reader would want.
- **Before committing, show the proposed title + body and let the user approve or tweak it.**

```bash
git add <files>
git commit   # with the title + body above
```

## Step 3 — Finish the feature

Push the branch and open a PR, then merge back to `main`.

**REQUIRED SUB-SKILL:** Use `superpowers:finishing-a-development-branch` for the
push / PR / merge / cleanup steps — don't duplicate them here.

## Quick Reference

| Thing | Rule |
|-------|------|
| Branch name | `feature/<short-name>` or `fix/<short-name>` |
| One branch | one feature or fix only |
| Commit title | imperative, ~50 chars, says what it does |
| Commit body | 1–3 lines: what + why |
| Before commit | show message to user for approval |
| Finishing up | use `superpowers:finishing-a-development-branch` |

## Common Mistakes

- **Committing to `main`.** Always branch first.
- **Vague titles** ("update", "wip", "fix stuff"). Say what changed.
- **Bundling several features** into one branch or commit. Keep them separate.
