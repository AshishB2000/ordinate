---
name: ordinate-review
description: Use when reviewing a diff, branch, commit or pull request in the Ordinate repo before it merges, or when asked "review this", "is this ready to merge", or whether a change follows the project's rules.
---

# Ordinate review

The rules are CLAUDE.md, `.claude/rules/` and the design docs they point to. This skill does not
restate them. It makes sure a review **covers every rule family**, **runs the checks**, and
**says plainly what it did not verify**. Reviewers here reliably catch the loud problems and
skip the quiet ones: a hard-coded server sentence, a reader without the row lock, an e2e test
that should be a unit test, checks never run.

## How to review

1. Read the whole diff, new files and tests first. Then read the code each change leans on (the
   cache key, the door it should go through, the contract it needs) before judging it.
2. Run the checks that apply (below) in a checkout that has the change. A check you did not run
   is reported as **not run** with the reason, never as passed. A green check proves only what
   it tests: lint does not see a shell call or a figure summed in React, and `check-contracts`
   only checks contracts that exist.
3. Fill the coverage table. **Every row gets `ok`, `issue N` or `n/a`.** A row left out counts
   as unreviewed.
4. Number the issues, most severe first. Leave out nits the linter or Prettier handles, and
   leave out praise.

## Coverage table

| Rule family | Look for | Rule lives in | Guard |
|---|---|---|---|
| Figures | the web sums, averages, rounds or derives a figure; a model writes a number; a new figure path that skips `vizDataFor` / `computeCardMetric` / `computeCard` | CLAUDE.md core principle; Live § doors | differential tests, `test-liveRoute` |
| Org isolation | an in-memory cache not keyed with `orgKey()`; a key missing an input that changes the answer; no invalidation on refresh or `epoch` | CLAUDE.md § Request context | — |
| Row access | a reader that returns rows, labels or figures without the row-policy lock (`withLockOf`, `src/ipc/rowDoors.ts`); a new `read` contract not classified in `scripts/rowPolicyReaders.ts` | `docs/row-policy/00-design.md` | `test-rowPolicySafetyNet` (needs `DATABASE_URL`) |
| Live datasets | a row reader that would compute on zero rows or hydrate a Live dataset; a catch that turns `LiveDatasetError` into `[]`/`null`; a new row-reading channel missing from the safety net | CLAUDE.md § Live datasets | `test-liveSafetyNet`, `test-liveRoute` |
| Resident layer | cast on the declared type only; ordinal at the end of every `ORDER BY`; the explicit empty class; `CAST(… AS DOUBLE)` on aggregates; `CASE WHEN` not `FILTER`; `null` on failure; JS reference plus an `Object.is` differential test plus `residentTrace` | CLAUDE.md § resident-query layer | the module's differential test |
| Contracts and access | a handler with no `src/api/` contract; `access` wider than needed; a loose zod input; ids not `Uuid`; missing `project`/`org` scope; append-only files that lost entries | CLAUDE.md § RPC | `node scripts/check-contracts.js`, `tsc` |
| Server text | a user-facing server sentence not written as `t('key', …)`; a figure formatted after `t()`; a hand-edited `en.json` | CLAUDE.md § Conventions | `test-i18n` |
| Untrusted input | SQL text or identifiers built from input; a user regex on the request thread; a child process with `shell: true` or a command string; a socket without the SSRF guard; a record id used in a path without `UUID_RE` | CLAUDE.md § DuckDB, Workspace, Conventions | lint (partly) |
| Secrets | a secret logged, sent to the browser or put in `config.json`; a new secret field with no canary test | CLAUDE.md § Secrets | `test-secrets` |
| Event loop | sync DuckDB, `execSync` or sync fs on a request path | CLAUDE.md § DuckDB | `test-asyncReach` (sync DuckDB only) |
| Migrations | not additive (DROP, rename, type change, NOT NULL with no default); an applied file edited; a per-org table without RLS forced; a number another open PR takes | CLAUDE.md § Postgres | `test-db-migrate`, CI `migrations` |
| Web | designed empty, loading and error states in both themes; a `<button>`, not a clickable `div`; `alt` and labels; heavy code lazy-loaded; no inline script or style (CSP) | CLAUDE.md § Web app | `npm --prefix web run size`, the screen's e2e |
| Tests | differential, not hand-written values; a negative control for every guard; golden fixtures never re-recorded to pass | CLAUDE.md § Testing | — |
| E2E or unit | for each new or changed e2e test: does it need the real server's data, real rendering it interacts with, or routing across screens? If not, it belongs in Vitest + Testing Library. Extend the screen's existing spec rather than adding one | CLAUDE.md § Testing | `rpcBudget`, `failOnConsoleError` |
| Size | a file over 500 lines (smell) or 800 (must split); the size allowlist edited to admit a file | `.claude/rules/file-size.md` | `test-file-size` |
| Dependencies | a new runtime dependency (needs the user's OK first) | CLAUDE.md § Out of scope | `audit` CI job |

## Checks

Run what the diff touches, after `npm run build:ts` (and `npm run build:web` for `web/`):

- `npm run lint` (blocking in CI) and `node scripts/check-contracts.js`
- each touched or named suite: `node scripts/test-<name>.js`. DB suites skip without
  `DATABASE_URL`, so a skip is **not run**.
- `npm run test:web` for `web/src` changes
- Leave the full smoke and e2e runs to CI. Say so under Checks.

## Report

```markdown
**Verdict:** merge | fix first | don't merge (one line on why)

**Issues**
1. **Short title**: `path/file.ts:42`. What breaks and for whom. The fix.
2. …

**Coverage**
| Rule family | Result |
|---|---|
| Figures | ok |
| Row access | issue 3 |
| Migrations | n/a (no migration in the diff) |
| … every row of the table above … | |

**Checks**
- `npm run lint` → clean
- `node scripts/test-rowPolicySafetyNet.js` → not run: no `DATABASE_URL`
```

For an e2e change, add one paragraph after Coverage: which tests must stay e2e and why, and
which belong in Vitest. Cite the test names.
