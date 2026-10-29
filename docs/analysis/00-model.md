# Dashboard — the record model

> **Revised for the single-artifact model.** This document originally described **two** artifacts:
> an editable *Analysis* you PUBLISHED into a read-only *Dashboard* snapshot. That model is gone. The
> published-Dashboard artifact — its record type, its CRUD, `analysis:publish`, the by-value inline
> `CardVisual` snapshot, the "snapshot guarantee", and the implicit "wrap a legacy dashboard in an
> analysis" migration — was **removed**. There is now **one** artifact: a **Dashboard**, which is the
> Analysis authoring surface renamed in the UI. It stays an `analysis` record on disk. Everything
> below describes that single surface.
>
> **Revised again for drafts and Publish** (`docs/superpowers/specs/2026-10-29-dashboard-drafts-publish-design.md`).
> Still one record — but it now keeps a **published copy inside itself** (`Analysis.published`). Every
> dashboard is a **draft** only editors and admins see; **Publish** freezes the draft, charts included,
> as the copy viewers read until the next Publish. See §0.5. This replaces the Ready flag.

**Internal name ≠ UI name.** The user-facing thing is a "Dashboard". Internally it is still an
`analysis`: the record type (`src/analysis/analysis.ts`), its store, the `analysis:*` IPC channels,
the `analyses` section id, and the `an*`/`dash*` filenames were all kept — renaming them buys nothing
and churns everything. Read "Dashboard (the UI)" and "`Analysis` (the record)" as the same object.

Every claim below is labelled **READ-FROM-CODE** (opened the file, it says this) or **REASONED** (a
conclusion drawn from the code). Nothing here is benchmarked on this branch.

---

## 0. The model, up front

1. **One editable artifact.** A Dashboard is an `Analysis` record: a multi-sheet canvas of cards
   (visual / metric / text / control) over the project's datasets, with dashboard-wide filters. It
   is always editable — there is no separate published, read-only copy. (READ-FROM-CODE:
   `src/analysis/analysis.ts`, `src/ipc/analyses.ts`.)
2. **Drafts and a published copy, in one record.** There is no `Dashboard` record type. The draft is
   the record's own content; `published` is a copy of it frozen at the last Publish (§0.5). Old
   published-dashboard JSON files from the desktop era are still not read by anything.
3. **Sharing = Export, of the published copy.** What leaves the app — a `/p/` page, an embed, an HTML
   export, a subscription, a report, a mention notice — is built from the published copy, or from the
   draft only when the dashboard was never published (only an editor can reach one).
4. **The app does the math.** Every number a card shows is recomputed on open by app code; the model
   never writes a computed figure. See §5.

### 0.5 Drafts and Publish (READ-FROM-CODE: `src/analysis/publishedCopy.ts`, `publishDashboard.ts`)

- **Who sees what.** Project editors and admins read the draft (and may ask for the copy —
  `analysis:open { published: true }`, the view page). A project **viewer** (read access only) reads
  the published copy **everywhere**: the store's `getAnalysis` / `listAnalyses` are caller-aware
  (`readsPublishedOnly`, the `authz/caller` rule row access uses), so a viewer gets the copy, and a
  dashboard never published is `null` — the same as a missing id. Paths that bypass the store guard
  themselves: dashboard history (`versions:*` — a viewer gets none), Trash, catalog notes, comment
  threads on a draft, mention notices. `scripts/test-dashboardDraftsViewer.ts` walks every reader as
  a viewer.
- **The copy** holds what an editor's save writes — name, sheets, filters, style, parameters — with
  each visual card's chart DEFINITION frozen into its inline `card.visual` (its `visualId` kept), plus
  `publishedAt`, `publishedBy`, `versionKey` (the version Publish recorded — `versions:diff` from it to
  now) and `contentHash` (the draft's edit tag at Publish). **No figure is stored**: every number is
  recomputed on render through the frozen definition. Saved views are not frozen (reader state, not
  content): the copy's readers get the record's views checked against the copy's sheets.
- **Status** (`statusOf`): `draft` (never published), `published` (the draft's content tag equals
  `contentHash` — so undoing back reads as in sync), `edited` (published, edits not live). A chart
  edited in Visuals does not change it: Discard could not undo that edit.
- **Publish / Unpublish / Discard edits** (`analysis:publish|unpublish|discard`, `write`) each record a
  version with an `event`. Publish and Unpublish leave the draft, its `updatedAt` and its edit tag
  alone; Publish takes the editor's `base` and refuses a draft that moved since (409). Discard puts the
  copy back as the draft — visual cards drop the frozen definition and draw their chart as it is now;
  it never writes to the shared Visuals store.
- **Ready → published.** A record still carrying the old `ready: true` is migrated on first read
  (`analysis.ts migrateReady`): a published copy of its content, charts frozen, `ready` removed, every
  other key byte for byte. Idempotent under the record's lock; if the write fails the read still
  treats it as published. Nothing writes `ready` any more.

---

## 1. What a rendered card depends on (READ-FROM-CODE)

No card stores a figure. Each is resolved from its spec + the dashboard's filters at render time.

| card type | resolved from | where |
|---|---|---|
| `metric` | `card.metric = {datasetId, column, aggregation, label?, format?}` → `dashboard:metric` → `residentQuery.computeMetricResident` \| `metricValue.computeMetric` | `src/ipc/dashboards.ts:174, 133`; `src/analysis/dashboards.ts:70` |
| `visual` | `card.visualId` → `visuals.getVisual` → `{datasetId, chartType, encoding, overrides, filters}` → `visual:data` → `vizData.buildVizData` | `renderer/hub/dashGrid.ts:601, 589, 609`; `src/ipc/visuals.ts:521` |
| `text` | `card.heading` / `card.text`, stored by value | `src/analysis/dashboards.ts:248-254` |
| `control` | `card.control = {kind, label, datasetId, column, default?}` → `controlSteps` → `FilterStep[]` (the reader's live selection — never persisted) | `src/analysis/dashboards.ts:51-57`; `src/analysis/dashboardFilters.ts:101` |
| all | the dashboard's `filters` merged in front of each card's own filters | `src/analysis/dashboardFilters.ts:39` |

So a Dashboard record stores **layout + text + metric/control specs + dashboard filters** by value,
and **the chart** by *reference* (`visualId`), resolved from the project's `visuals/` store at render
time. A dangling `visualId`/`datasetId` renders a placeholder, never a crash
(`src/analysis/dashboards.ts:19-21`). This is the whole dependency surface — there is no fourth thing
a card can read.

---

## 2. Record shapes

Storage: `analyses/` is a fourth sibling of `datasets/`, `visuals/`, `dashboards/` under
`userData/projects/<projectId>/`, one `<analysisId>.json` per record. Same conventions as the other
stores (READ-FROM-CODE, `src/analysis/analysis.ts`): the dual-UUID guard (`UUID_RE` on **both**
`projectId` and record id before either touches a path), atomic temp-sibling-then-`rename` writes
with a per-write `randomUUID()` suffix, `normalize()` re-sanitising every stored field on load, and a
corrupt/unreadable file being skipped rather than fatal. `getAnalysis`/`listAnalyses` read as the
caller may (§0.5); their one write is the once-only Ready migration.

### 2.1 `Analysis` (`src/analysis/analysis.ts`)

```ts
export interface Analysis {
  id: string;                       // generated UUID — never derived from the name; it is a path
  projectId: string;                // re-supplied by the loader, never trusted from the file
  name: string;
  sheets: Page[];                   // the authoring surface. A sheet IS a dashboards.Page (§2.3).
                                    // Always ≥ 1, the invariant sanitizePages() enforces.
  filters: FilterStep[];            // dashboard-wide cross-card filters (filter-only steps)
  style: DashboardStyle;
  parameters: Parameter[];
  views?: SavedView[]; defaultViewId?: string;
  published?: PublishedCopy;        // what viewers see (§0.5); absent = a draft. Not content.
  createdAt: string;
  updatedAt: string;                // bumped by any sheet/filter/name edit (never by Publish)
  schemaVersion: 1;
}
```

`sheets` is the point of the record: it is typed `Page[]` so the existing `sanitizePages` runs
unchanged. `filters` reuses `FilterStep[]` so `mergeDashboardFilters` / `sanitizeDashboardFilters` /
every downstream `applyPipeline` path work with no new code. Deliberately **absent**: `visuals`,
`datasets` (referenced by id, never owned), and any `layout`/`gridCols` field — `dashboards.GRID_COLS
= 12` is the single exported source (`src/analysis/dashboards.ts:61`) and a second would drift.

### 2.2 `Card` and the card types (`src/analysis/dashboards.ts`)

The Card/Page vocabulary and its sanitizers live in `src/analysis/dashboards.ts` — a filename kept
from the deleted Dashboard record. `analysis.ts` re-exports these types and calls `sanitizePages` /
`sanitizeDashboardFilters`.

```ts
export type CardType = 'visual' | 'text' | 'metric' | 'control';

export interface Card {
  id: string;                       // UUID — a stable key only, never a filesystem path
  type: CardType;
  layout: CardLayout;               // {x,y,w,h} clamped onto the fixed 12-col grid (sanitizeLayout)
  visualId?: string;                // type 'visual' — the reference, resolved at render time
  visual?: CardVisual;              // type 'visual' — a dormant inline shape (see below)
  heading?: string;                 // type 'text'
  text?: string;                    // type 'text'
  metric?: CardMetric;              // type 'metric' → the ONE app-computed number
  control?: CardControl;            // type 'control' → a filter widget's DEFINITION
}

export interface CardMetric  { datasetId; column; aggregation; label?; format?; }
export interface CardControl { kind; label; datasetId; column; default?; }
export type    CardVisual = Pick<Visual, 'datasetId'|'name'|'chartType'|'encoding'|'overrides'|'filters'>;
```

A draft's visual card carries `visualId` and is resolved from the `visuals/` store at render. A
published copy's visual card also carries the chart's definition frozen at Publish as `card.visual`
(`CardVisual`, overlays included), and **that wins** wherever the copy is drawn or computed: the open
reply hands the frozen definitions to the canvas as its `visuals`, and `/p/`, exports, subscriptions
and reports read `card.visual` first.

`CardControl` stores only the widget's *definition*; the reader's live selection becomes a
`FilterStep` via `controlSteps` and is never persisted (`src/analysis/dashboards.ts:39-49`).

### 2.3 `Page` is a sheet — one type, two names

`Page = { id, name, cards: Card[] }` (`src/analysis/dashboards.ts:114-118`), laid out on the fixed
12-column grid, with the renderer shipping multi-sheet tabs, add / rename / remove, and per-sheet
card grids. `Analysis.sheets` and the renderer's `pages` are **the same array** — the editor aliases
them rather than copying: `a.pages = a.sheets; // alias, NOT a copy — one array, two names`
(`renderer/hub/dashGrid.ts:40`). The two words exist because "sheet" is the Dashboard surface's term
and `Page` is the type's historical name; a parallel `Sheet` type would fork
`sanitizePage`/`sanitizePages`/`sanitizeCards`/`sanitizeLayout` for nothing.

One real gap, named not hidden: `Page` has no per-sheet filters. If ever wanted it is an additive
`filters?: FilterStep[]` on `Page` plus one argument to `mergeDashboardFilters`. Out of scope.

---

## 3. Sharing = Export

There is no published record, so "share" is the by-value snapshot export, unchanged from before:

- **`src/analysis/dashboardExport.ts`'s `sanitizeBundle` is a SECURITY CONTROL** (READ-FROM-CODE,
  header at `:23`). The export bundle is untrusted renderer input; `sanitizeBundle` whitelists it
  field-by-field to a fixed primitive schema — **labels / numbers / strings and `data:image;base64`
  URIs only**. Any key not in that schema is dropped, so a stray config value or secret cannot ride
  out in an export. This is the one non-negotiable in the export path.
- **The renderer assembles the bundle from the OPEN sheet.** `renderer/hub/dashShare.ts` reads
  `dashCurrent.pages` (`:87`, `:120`) — which is the alias of the analysis's `sheets` (§2.3) — so the
  export reflects the **live editor state**, never a stored snapshot. There is nothing else it could
  read.
- **`src/ipc/dashboardExport.ts` writes it**: `dashboard:exportHtml` / `dashboard:exportPng` /
  `dashboard:exportPdf` (plus `dashboard:revealFolder`). Each runs `sanitizeBundle` before anything
  is written; the HTML renders with the network off (Chart.js inlined from disk, only `data:` images).

---

## 4. IPC surface (READ-FROM-CODE)

**`src/ipc/analyses.ts`** — the authoring channels, wired in `main.ts:639`. Every handler is
`ipcMain.handle`; a throw becomes `{ ok:false, error }`. No deps object (pure disk + the model call).

| channel | payload → result | notes |
|---|---|---|
| `analysis:list` | `{projectId}` → `AnalysisSummary[]` | newest-updated first, corrupt files skipped; uncontracted (the browser reads `analysis:gallery`) |
| `analysis:get` | `{projectId, id}` → `Analysis \| null` | as the caller may read it (§0.5); uncontracted (the browser reads `analysis:open`) |
| `analysis:gallery` | `{projectId}` → items with `status`, `publishedAt?`, `publishedBy?` | a viewer's: published ones, from the copy |
| `analysis:open` | `{projectId, id, published?}` → `{analysis, visuals, tag, status, showing, published?}` | `published`: the copy (frozen charts as `visuals`); a viewer always gets it |
| `analysis:publish` | `{projectId, id, base?}` → `{status, published}` | freezes the draft; a version; 409 on a stale `base` |
| `analysis:unpublish` | `{projectId, id}` → `{status}` | the draft stays; a version |
| `analysis:discard` | `{projectId, id}` → `{analysis, tag, status, published}` | the copy back as the draft; a version |
| `analysis:create` | `{projectId, name, sheets?, filters?}` → `Analysis \| {ok:false,error}` | `sheets` optional so `analysis:draft` can hand its packed sheets straight in |
| `analysis:rename` | `{projectId, id, name}` → `{ok, analysis}` | |
| `analysis:update` | `{projectId, id, name?, sheets?, filters?}` → `{ok, analysis}` | full array replace, not a patch-merge |
| `analysis:delete` | `{projectId, id}` → `{ok}` | |
| `analysis:draft` | `{projectId, datasetId?, intent?}` → plan preview \| `{notReady:true}` | AI. FACTS in (no rows, no secrets), a validated plan envelope out; nothing saved |
| `analysis:previewPlan` | `{projectId, plan}` → preview | NOT AI — re-validate a user-edited plan |
| `analysis:buildPlan` | `{projectId, plan}` → built records | NOT AI — re-validate + create the records |

**`src/ipc/dashboards.ts`** — holds **only `dashboard:metric`** now (the ONE app-computed number for
a metric card; `main.ts:635`). The old dashboard CRUD is gone.

**`src/ipc/dashboardExport.ts`** — the export channels of §3 (`main.ts:641`).

**`src/ipc/visuals.ts`** — unchanged. A visual card resolves through the existing `visual:data`
channel (`:521`); there is no dashboard-specific charting IPC.

No new `BrowserWindow` — the Dashboard surface is a hub workspace section, per the "settings/about/
permission are inline panels, never a new window" rule.

---

## 5. The app does the math — the model never writes a number

The strict-number rule holds across this whole surface (READ-FROM-CODE):

- **Metric cards** compute in main via `computeMetric` / `computeMetricResident`, both pure app code
  over the stored table; the renderer never computes a figure and no model is involved
  (`src/ipc/dashboards.ts:11-21, 174`).
- **Visual cards** draw from `vizData.buildVizData` over the live dataset, through `visual:data`.
- **The AI draft flow** (`analysis:draft` → `previewPlan` → `buildPlan`) has the model emit only
  *structure* — sheet/card/calc-field descriptions — which `analysisPlan.validatePlan` re-checks and
  the app then fills with app-computed numbers. Every figure in a preview came out of `vizDataFor`,
  the same function that draws the built visual (`src/ipc/analyses.ts:15-17, 38-41`). The model puts
  app-found figures into words; it never authors one.

---

## 6. What must not regress

Small and load-bearing:

1. **The export sanitizer stays strict.** `sanitizeBundle` must keep whitelisting to
   labels/numbers/strings/`data:image` only — it is a secret-exclusion control, not a formatter.
   Widen it and a config value or key can leave the app. (`src/analysis/dashboardExport.ts:23`.)
2. **Metric numbers stay app-computed.** `dashboard:metric` computes in main via the pure helpers;
   no figure is ever stored or model-authored.
3. **`sheets` ↔ `pages` is an alias, not a copy.** One array under two names
   (`renderer/hub/dashGrid.ts:40`); anything that deep-copies it silently forks the editor from what
   gets saved and exported.
4. **A draft's cards reference visuals by id; a published copy's carry them frozen.** A dangling
   reference degrades to a placeholder, never a crash. Where `card.visual` is present it wins; nothing
   may assume it is.
5. **A viewer never reads a draft.** Not its content, its name, its history or its threads, on any
   channel (`scripts/test-dashboardDraftsViewer.ts`). A new reader goes through `getAnalysis` /
   `listAnalyses`, or guards itself and joins that walk.
