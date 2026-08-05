# Ordinate — agent instructions

**[`CLAUDE.md`](CLAUDE.md) is the architecture reference. Read it first, and treat it as
authoritative.** It documents the data layer, the IPC surface, the config schema, the on-disk store
layout, the security model, and every phase decision with the measurements behind it.

This file is deliberately a pointer rather than a copy.

> **Why.** AGENTS.md used to be a byte-identical duplicate of CLAUDE.md. It drifted, and by the time
> anyone noticed it was claiming that the DuckDB migration, MapLibre, Mosaic and Svelte were all
> "planned — NOT built" — every clause false. In this repo that is not a cosmetic problem: a stale
> architecture note once caused an audit pass to stash the live `maplibre-gl` dependency mid-port as
> "stray … contradicts phase-3 §3", destroying work in progress. Two copies of a 466-line document
> cannot be kept in sync by hand, so there is now one copy.

---

## What this project is

A **local-first, open-source personal BI workspace.** Data comes in (files, paste, Excel, Postgres,
a URL/API, or a screenshot capture) → **prepare** it with a reversible transform pipeline →
**visualize** across 28 chart & map types → assemble **dashboards** → **share** offline. AI is
optional at every step. MIT.

**Core principle: the app does the math.** Aggregation, statistics, metrics and anomaly detection
all run in deterministic, auditable code. A model may extract structure (a table from a screenshot)
or narrate figures the app already computed — it **never** writes a computed number.

## Rules that must not be got wrong

These are the ones where a mistake is expensive or silent. Everything else is in CLAUDE.md.

- **Branch off `develop` for every change** (`fix/…`, `feat/…`, `perf/…`, `test/…`, `docs/…`), then
  open a pull request. `develop` is the default branch and the trunk; `main` sits at the initial
  import and is unused. **Never commit directly to either.** If the trunk is ever renamed again,
  the branch lists in `ci.yml`/`lint.yml` must move with it — otherwise CI stops running silently.
- **Never** add a `Co-Authored-By` trailer or any AI co-author line to a commit message.
- **No `eval`, no `new Function`, anywhere.** User and model input never becomes executable code.
  The formula evaluator is a hand-written tokenizer + parser + tree-walker for exactly this reason.
- **Secrets never leave the main process.** API keys and connection secrets live in
  `userData/config.json`; `publicConfig()` / `publicByok()` are the only renderer-safe views, and
  they strip every raw value. Nothing secret reaches a renderer, a project folder, or an export.
- **Local CLI execution is shell-free** — `execFile`/`spawn` with an args array, never `shell: true`.
  The app **detects and runs only; it never installs anything** for the user.
- **Strict number parsing is a correctness guarantee.** `007`, zip codes and >15-digit identifiers
  stay text. See `isFiniteNumber` / `finalizeTable` in `src/parse.ts`.
- **The hub CSP is strict** (`default-src 'none'; style-src 'self'; script-src 'self'`). No inline
  `style=` in hub HTML — use a `hub.css` class. Setting `element.style.x` from JS is fine.
- **Every resident (SQL) path keeps its pure-JS original**, falls back to it on any failure, and is
  guarded by a *differential* test asserting the two agree. Change one, change or re-verify the
  other.
- **Ask before adding a runtime dependency.** Prefer stdlib, native platform features, or something
  already installed.

## Commands

```bash
npm start          # run the app
npm test           # scripts/test-*.js self-checks (~3,300 assertions)
npm run smoke      # launch the REAL app via Playwright; fails on any renderer console error
npm run build:ts   # tsc, in-place sibling emit, no bundler
```

`npm run smoke` is the only check that runs the actual application, and the only one that catches a
CSP violation or a broken renderer. Run it for anything touching the hub.

---

Everything else — architecture, module layout, the full IPC table, config schema, phase history and
the reasoning behind each decision — is in **[`CLAUDE.md`](CLAUDE.md)**.
