---
paths:
  - "deploy/**"
  - ".github/**"
---

# Deploy and CI

## Deploy

- `deploy/Dockerfile`: non-root, amd64 + arm64, **≤ 600 MB** (CI-enforced). The image bakes
  DuckDB's `httpfs`/`aws` extensions and the GeoJSON, so nothing installs at run time.
- `deploy/docker-compose.yml` adds Postgres and MinIO. The app port binds to `127.0.0.1` only.
- `deploy/helm/ordinate`: a migration hook Job, a metrics Service never on the Ingress, and secrets
  only through `existingSecret`.
- `/metrics` is served only on `METRICS_PORT`.
- Every env var is in `docs/server/configuration.md`; `test-serverDocs` enforces it.

## Images

- Every green push to `develop` publishes `ghcr.io/<owner>/ordinate:edge` (ci.yml's `edge` job,
  through `release.yml`'s image job).
- A versioned release (`release.yml`: image + chart on a `v*` tag) has never been cut. Releasing is
  the owner's call.

## CI

- `ci.yml` runs on every PR to `develop` with jobs `check`, `web`, `audit`
  (`scripts/audit-gate.ts`), `docker`, `helm` and `migrations` (fails a PR that adds a migration
  number another open PR also adds), plus `lint.yml`.
- The `develop` ruleset (`.github/rulesets/develop.json`) requires **`smoke (all shards)`** (which
  aggregates check, web, docker, helm, audit and migrations) and **`oxlint (blocking)`**, and
  refuses a direct push.
- Actions are pinned by commit; Dependabot bumps them.
- Renaming the trunk means editing the `branches:` lists in both `ci.yml` and `lint.yml` in the
  same commit.
- A failed nightly opens an issue. `e2e-nightly.yml` runs Firefox and WebKit.
  `warehouse-nightly.yml` runs `scripts/test-warehouseLive.ts` against real Snowflake and BigQuery
  accounts from repo secrets; it skips, green, without them (locally too).
