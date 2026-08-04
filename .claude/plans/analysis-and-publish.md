# Brief: Analyses, sheets, publishing — and an AI that builds a whole analysis

You are adding a major feature to a working application. Read this whole brief before touching
code. **Read `CLAUDE.md` first** — it documents the IPC surface, the on-disk stores, the security
model and the phase history. Do not re-derive any of it.

---

## 1. Mission

Adopt the **QuickSight authoring model**, adapted rather than copied:

| | |
|---|---|
| **Analysis** | Where you *work*. Owns **sheets**; each sheet lays out visuals. Mutable, private, iterative. |
| **Dashboard** | What you *publish*. A read-only artifact produced from an analysis. Shareable, stable. |

Plus the reason this is worth doing: **an AI that builds an entire analysis from a request.** The
user asks; the model proposes a *plan*; the app renders a **preview** — real charts from real data,
plus the calculated fields it intends to create — and only on approval does it build the analysis.

Tableau is the reference for *depth of authoring*. QuickSight is the reference for *the
analysis → dashboard split*. Take the split from QuickSight; do not copy its UI.

---

## 2. Current state — what already exists

Read these before designing anything. Several pieces of the target already exist under other names.

**`src/visuals.ts`** — a visual is a flat, project-level record:

```ts
interface Visual {
  id, projectId, name, datasetId,
  chartType,            // ALL_CHART_TYPE_IDS ∪ {table, map_bubble, map_choropleth}
  encoding: VizEncoding,
  overrides: VizOverrides,   // chart styling
  filters: FilterStep[],     // visual-level, applied BEFORE aggregation
  createdAt, updatedAt, schemaVersion: 2
}
```

**`src/dashboards.ts`** — and note this carefully:

```ts
interface Page { id, name, cards: Card[] }
interface Dashboard { id, projectId, name, pages: Page[], filters: FilterStep[], … }
```

> **`Page` is already a sheet.** A dashboard is already a multi-page grid of visual / text / metric
> cards with dashboard-wide cross-visual filters. So this feature is **not** "add sheets" — it is
> **"split the mutable authoring surface from the published artifact"**, and the layout model you
> need mostly exists. Reuse `Page`/`Card` rather than inventing a parallel one.

**AI entry points that already exist** (`src/analyze.ts`): `suggestChart`, `suggestCalcField`,
`draftDashboard`. The last one is the closest ancestor of what you are building — read it first and
decide whether to extend it or supersede it. Do not leave two competing drafting paths.

**Everything else you need is built:** `vizData.buildVizData` produces `{labels, series}` for any
encoding; `residentQuery` answers aggregates straight off Parquet; `formula.ts` is a safe expression
evaluator with 82 functions; `dashboardFilters.ts` merges filters per card.

---

## 3. The target model

```
Project
 └── Analysis                     ← NEW. The authoring container.
      ├── sheets: Sheet[]         ← reuse Page: { id, name, cards: Card[] }
      ├── filters: FilterStep[]   ← analysis-wide, same semantics as today's dashboard filters
      └── publishedDashboardIds[]
 └── Dashboard                    ← now a PUBLISHED SNAPSHOT of an analysis
 └── Dataset, Visual              ← unchanged on disk
```

**Publishing is a snapshot, not a link.** Editing an analysis after publishing must NOT change the
live dashboard until the user publishes again. This is the property that makes a dashboard safe to
share, and it is the single most important behaviour to get right.

Two decisions to make explicitly and record in the doc you write:

1. **Do visuals move under an analysis, or stay project-level and get referenced?** Staying
   project-level is far less disruptive — dashboards already reference visuals by id — but it means
   a visual can be edited from outside the analysis that shows it. Pick one and say why.
2. **Do existing standalone dashboards survive?** The user said dashboards may or may not come from
   an analysis. The cheapest honest answer is that every existing dashboard is lazily wrapped in an
   implicit analysis on first edit. Decide, and make the migration one-way and lazy, exactly as the
   v2→v3 dataset migration was.

---

## 4. The AI flow — the actual point of this feature

**A model proposes structure. The app computes every number. This is not negotiable** — it is the
project's core principle (`CLAUDE.md`, "the app does the math").

```
User: "show me revenue by region over time, and flag the outliers"
   │
   ├─ 1. App builds a FACTS block: dataset names, column names + types, row counts,
   │     and per-column stats — all from statsResident/getDatasetMeta. No rows.
   │
   ├─ 2. Model returns a PLAN ENVELOPE. Structure only, no computed values:
   │        { sheets: [{ name, visuals: [{ datasetId, chartType, encoding, filters }] }],
   │          calculatedFields: [{ datasetId, name, formula }],
   │          rationale: "…" }
   │
   ├─ 3. App VALIDATES the plan (see landmines) and renders a PREVIEW:
   │        • every chart drawn from REAL data through buildVizData
   │        • every calculated field compiled by formula.ts and shown with sample output
   │        • anything invalid is dropped and reported, never silently kept
   │
   ├─ 4. User approves, edits, or rejects.
   │
   └─ 5. On approval the app BUILDS it — creates the calculated fields as real prepare
         steps, creates the visuals, lays out the sheets. All through existing APIs.
```

**The preview is rendered by the app, not described by the model.** The model never sends a picture,
a number, or a summary of results — it sends a plan, and the app draws what that plan would produce.
If the preview and the built result can ever differ, the design is wrong.

Gate the whole flow on `config.executionReady()` and return `not_ready` with no model configured,
exactly like every other AI feature.

---

## 5. Invariants — do not break these

1. **The app does the math.** A model may name a column, a chart type, an aggregation or a formula.
   It may never produce a figure that reaches the screen.
2. **AI is optional.** Everything except the AI features must work with no model configured.
3. **Publishing is a snapshot.** An analysis edit never silently changes a published dashboard.
4. **Reversible prepare pipeline.** AI-created calculated fields are ordinary `TransformStep`s
   appended to a dataset's step list — removable, reorderable, no special case.
5. **No `eval`, ever.** An AI-proposed formula goes through `formula.ts`'s parser like any user
   formula. It is data, not code.
6. **Secrets never leave main.** The FACTS block is assembled in main and must never carry a
   connection secret or an API key.
7. **Path hardening.** Every new record id is a generated UUID validated by `UUID_RE` before it
   touches a path; writes are atomic (temp sibling then rename); a corrupt file is skipped, never
   fatal.
8. **Strict number parsing.** `007` stays text. AI-proposed calculated fields must not smuggle
   coercion in.
9. **New IPC goes in `src/ipc/*`**, not `main.js`.
10. **Never hydrate a whole table** to build a preview. Use `getDatasetMeta`, `statsResident` and
    the resident query path. A preview that costs 4 seconds at 1M rows is a bug.

---

## 6. Landmines

**6.1 — The chart-type vocabulary is closed.** `renderResult.ts` owns `VIZ_LABELS` (28 types) and
`ALL_CHART_TYPE_IDS`. A model WILL invent chart types. Validate against the list and **drop
off-list entries**, exactly as `analyze.parseReply` already does for the capture path. Copy that
pattern; do not invent a second one.

**6.2 — An AI-proposed formula must compile before it is stored.** `formula.ts` has a real parser.
Compile every proposed formula in the preview step; a formula that fails to compile is reported and
dropped, never written to disk. Four of `test-formula.ts`'s assertions are anti-injection tests —
read them before you decide what "valid" means.

**6.3 — An encoding the model proposes may not fit the data.** A `sum` over a text column is a
binder error, not a chart. Validate every proposed encoding against the dataset's real column types
before previewing, and drop what cannot render.

**6.4 — Migration is one-way and lazy.** Existing dashboards and visuals must keep opening. Follow
the v2→v3 dataset precedent in `src/datasets.ts`: migrate on read, gate on the bridge being
available, never migrate during a metadata-only read.

**6.5 — `draftDashboard` already exists.** Decide up front whether the new flow replaces it. Two AI
paths that both create dashboards, differing subtly, is the worst outcome.

**6.6 — Dashboard export must keep working.** `dashboardExport.ts` produces self-contained HTML with
`sanitizeBundle` as a **security control** — whitelist only, no secrets, no `http(s)` images. If a
dashboard is now a snapshot of an analysis, make sure export still reads a complete, self-sufficient
record.

---

## 7. Phases

One branch per phase off `devops`, one PR each. **Do not start a phase until the previous one's gate
passes.**

### Phase A — Spec, and the two decisions
No product code. Write `docs/analysis/00-model.md`: the record shapes, the migration path, the two
decisions from §3 with reasoning, and the full list of existing behaviour that must not regress.
**Gate:** the doc, plus `npm test` green at the current count.

### Phase B — The Analysis record and store
`src/analysis.ts` mirroring `dashboards.ts` conventions: UUID validation, atomic writes, corrupt
files skipped. Sheets reuse `Page`/`Card`. IPC in `src/ipc/analysis.ts`. Lazy migration of existing
dashboards.
**Gate:** self-checks for the store, including a planted pre-migration file that upgrades correctly.

### Phase C — Publishing
Analysis → dashboard snapshot. Republish updates it; editing the analysis does not.
**Gate:** a test proving an analysis edit after publish leaves the dashboard byte-identical.

### Phase D — The authoring UI
The renderer surface for analyses and sheets. Renderer files are **global-scope classic scripts** —
no import/export. Hub CSP is strict: **no inline `style=`**, use `hub.css` classes.
**Gate:** `npm run smoke` passes; it fails on any renderer console error, which is the only check
that would catch a CSP violation.

### Phase E — The AI plan + preview
The plan envelope, validation, the app-rendered preview, and build-on-approval.
**Gate:** with no model configured everything returns `not_ready` and the app is fully usable; with
one, a plan containing an invalid chart type, an uncompilable formula and a bad encoding is
previewed with those three dropped and reported.

---

## 8. Rules of engagement

- Branch off `devops` (`feat/…`); never commit to `devops` or `main` directly.
- **Never** add a `Co-Authored-By` or AI co-author trailer to a commit message.
- `npm test` green at every phase gate. Never delete a failing assertion to go green — if behaviour
  must change, change the test deliberately and say so in the commit body.
- **`npm run smoke` is the only check that runs the real app.** Run it for anything touching the hub.
- Differential tests are the house style: when two implementations exist, assert they agree with
  `Object.is` rather than against hand-written expectations.
- Ask before adding a runtime dependency.
- Report scope problems early. A wrong guess about the visual-ownership decision in §3 is much
  cheaper to fix in Phase A than in Phase D.

---

## 9. First action

Do not write product code yet. Run `npm install && npm run build:ts && npm test`, confirm the
baseline is green and record the number. Read `CLAUDE.md`, `src/visuals.ts`, `src/dashboards.ts`,
`src/vizData.ts` and `analyze.ts`'s `draftDashboard`. Then produce the Phase A document — especially
the two decisions in §3 — and bring it back before starting Phase B.
