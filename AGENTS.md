# Ordinate — agent instructions

**[`CLAUDE.md`](CLAUDE.md) is the architecture reference. Read it first and treat it as
authoritative.** This file is a pointer, not a copy: two copies of one long document drifted apart
once, and a stale note cost real work.

## What this project is

A **self-hosted, open-source BI web app.** A company runs it in its own infrastructure (Docker
Compose, Kubernetes via Helm, ECS), and people open a URL and sign in. Bring data in → **prepare**
it with a reversible pipeline → **visualize** it → author **analyses** → publish **dashboards**.
AI is optional at every step. MIT.

**Core principle: deterministic engines do the math, never a model.** Ordinate's own engine
(or the source warehouse, for a Live dataset) computes every figure. React only formats what the
server returns. A model may extract structure or narrate figures an engine computed; it never
writes a computed number.

## Rules that must not be got wrong

A mistake here is expensive or silent. The reasons, and everything else, are in CLAUDE.md.

| Rule | In short |
|---|---|
| **One worktree per change** | `git worktree add -b feat/x .claude/worktrees/x origin/develop`, then a PR to `develop`. Never commit to `develop`, and never `git checkout` in the shared clone. |
| **No AI co-author** | Never add a `Co-Authored-By` trailer or any AI co-author line to a commit. |
| **No release without the owner** | No tag, GitHub release or image push unless the owner asks. |
| **No contract, no channel** | Every RPC channel has a zod contract in `src/api/` with the narrowest access. `src/api/index.ts`, `web/src/app/routes.tsx` and `web/src/app/nav.ts` are append-only. |
| **Org isolation** | Every in-memory cache is keyed with `orgKey()`. Every record id and org id is validated before it touches a path. |
| **Secrets stay on the server** | Never logged, never sent to a browser. A new secret field gets a canary test. |
| **Never block the event loop** | Request paths use the async DuckDB calls. User regex runs in a worker. |
| **No `eval`, no `new Function`** | User and model input never becomes executable code. No child process built from a user string, and never `shell: true`. |
| **Strict number parsing** | `007`, ZIP codes and long ids stay text. Cast on the declared column type, never by inference. |
| **Two implementations agree** | Every fast SQL path keeps its pure-JS reference and a differential test. Change one, re-verify the other. |
| **Additive migrations only** | A rollback does not undo a migration. |
| **Ask before adding a runtime dependency** | Prefer the standard library, the platform, or something already installed. |
| **File size** | 500 lines soft, 800 hard. See [`.claude/rules/file-size.md`](.claude/rules/file-size.md). |

## Commands

```bash
npm run server              # build, then the server on 127.0.0.1:8080 (needs DATABASE_URL, or AUTH_MODE=dev)
npm run dev:web             # Vite dev server with hot reload
npm test                    # every server self-check suite
npm run test:web            # web unit tests (Vitest)
npm --prefix web run e2e    # Playwright end-to-end tests, one per screen
npm run lint                # oxlint; zero findings, blocking in CI
```

Everything else is in **[`CLAUDE.md`](CLAUDE.md)**: the architecture, the module layout, the
testing style and the reasoning behind each decision. History and measurements are in
[`docs/`](docs/README.md).
