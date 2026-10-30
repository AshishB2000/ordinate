---
paths:
  - "src/data/**"
  - "src/connectors/**"
  - "src/formula/**"
  - "src/analysis/**"
  - "src/ai/**"
---

# Workspace: sources, prepare, visuals, dashboards, AI

## Sources

- `src/data/parse.ts` centralises parsing. Its `isFiniteNumber` is strict, so `007`, ZIP codes and
  ids over 15 digits stay text.
- **`src/connectors/` is a REGISTRY of read-only sources:** one connector is one entry, never a
  union type. Wire-compatible sources share a driver (`postgres.ts`, `mysql.ts`, `http.ts`,
  `saas.ts`, `mssql.ts`, `oracle.ts`, `url.ts`, `snowflake.ts`, `bigquery.ts`). Oracle runs in
  thin mode only, never `initOracleClient`.
- Connector rules:
  - Read-only.
  - Secrets never leave the server; replies carry `secretSet` flags.
  - **Every query is bounded server-side.** User SQL goes on its own line inside the dialect's
    wrapper: a trailing comment once dropped the cap (F3/F3b).
  - **Every socket goes through the SSRF guard** (`src/connectors/ssrf.ts`): check every resolved
    address, pin to it, re-check each redirect. Private ranges only through `SSRF_ALLOW`.
- **No dataset origin reaches a browser:** no file path, keyed URL or SQL text. Replies carry
  `{kind, label, refreshable}` (`dataset:source`). The server keeps no `file` origin (F1).

## Captures

- A capture is a SOURCE: upload a screenshot → `captureDataset:draft` → the composer → `composeSave`.
  The composer's preview cells are editable because they are a model's reading of an image. It is
  the one origin that cannot be re-fetched.
- Uploaded on the Captures tab, a capture opens its own page (`/data/captures/<project>/<id>`,
  `captureDataset:get` / `:image`): the screenshot beside the stored analysis. The headline,
  metrics and chart data are the app's, with no second model call.
- "Build an analysis" still goes through the composer's cell check (`then=analysis`) before the
  new-dashboard wizard opens on the saved dataset.

## Prepare and formulas

- `src/data/transforms.ts` folds ordered steps over an immutable copy, so removing a step
  recomputes from source. An unknown step is skipped with a warning.
- `src/formula/` is a hand-written tokenizer, parser and tree-walker. **No `eval`, no
  `new Function`, ever** (lint-enforced).

## Visuals

- `buildVizData` (`src/analysis/vizData.ts`) is the pure bridge to `{labels, series}`. Chart ids
  are in `web/src/charts/vizLabels.ts` (`VIZ_LABELS`).
- Pivot, cohort and event funnel are `<table>` grids computed BESIDE it. **Pivot subtotals are
  recomputed from the source, never folded from the cells above.**
- Dashboard metric numbers are computed on the fly, never stored.

## Dashboards (`analysis` records; spec `docs/analysis/00-model.md`)

- Every dashboard is a **draft** that only editors and admins see.
- **Publish** freezes a copy inside the record (charts too, as `card.visual`) that viewers read
  until the next Publish. The figures stay live.
- A viewer gets the published copy or nothing from `getAnalysis` / `listAnalyses`, which are
  caller-aware. A reader that bypasses them guards itself and joins `test-dashboardDraftsViewer`.

## AI (optional; `not_ready` without a model)

- API-key providers only. Keys are per org in the secrets store, and calls go through
  `src/ai/providerFetch.ts` (SSRF-guarded).
- Admin → AI approves exact models. Each member's pick and the rest of the setup are in Postgres
  (`src/server/aiConfig.ts`, `docs/ai-models/`).
- `src/analysis/anomalies.ts` is a pure detector. The model only puts app-found figures into words.
