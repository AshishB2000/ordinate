# Analysis — the record model, and the two decisions

**Status:** spec only. No product code exists on this branch (`feat/analysis-spec`, off `develop`).
**Tests:** `npm test` → **4,334 ok / 0 fail** (MEASURED, this branch, unchanged — nothing was edited).
**Scope of this document:** the on-disk shapes, the publish semantics, the migration, the IPC surface,
and the list of behaviour Phase C is not allowed to break.

Every claim below is labelled **READ-FROM-CODE** (I opened the file and it says this),
**REASONED** (a conclusion I drew, arguable), or **MEASURED** (I ran it). Nothing here is measured
except the test count — this phase writes no code and benchmarks nothing.

---

## 0. The verdict, up front

1. **Visuals stay project-level.** An analysis references them by id, exactly as a dashboard does
   today. **Publishing denormalises**: it copies each referenced `Visual`'s definition *by value*
   into the published card. Cost: `Card` grows a second, mutually-exclusive shape, and every one of
   the four places that resolves `card.visualId` has to learn the inline form.
2. **Existing standalone dashboards survive untouched, and are wrapped in an implicit analysis on
   first EDIT — not on read.** Cost: a dashboard is now two things depending on `analysisId`, and the
   wrap is one-way, so "unwrap" is not offered.
3. **`analysis:draft` supersedes `dashboard:draft`.** The channel is deleted, not aliased. The model
   call `analyze.draftDashboard()` keeps its name.

And one thing the brief got wrong, stated loudly here because it is cheaper to fix now:
**`Page` in `src/dashboards.ts` is already a sheet, and the brief's own note is correct — but the
brief also asks the migration to be "gated on the bridge being available, exactly like the v2→v3
dataset migration". It must not be.** See §4.3.

---

## 1. What a rendered card actually depends on (READ-FROM-CODE)

The snapshot guarantee cannot be designed without knowing the full input set of one card. There is
no stored figure anywhere in the dashboard path — every number is recomputed on open:

| card type | resolved from | where |
|---|---|---|
| `metric` | `card.metric = {datasetId, column, aggregation, label, format}` → `dashboard:metric` → `residentQuery.computeMetricResident` \| `metricValue.computeMetric` | `src/ipc/dashboards.ts:323`, `137` |
| `visual` | `card.visualId` → `visuals.getVisual` → `{datasetId, encoding, chartType, overrides, filters}` → `visual:data` → `vizData.buildVizData` | `renderer/hub/dashboards.ts:585-618`, `src/ipc/visuals.ts:193` |
| `text` | `card.heading` / `card.text`, stored by value | `src/dashboards.ts:181-187` |
| all | `Dashboard.filters` merged in front of the card's own filters | `src/dashboardFilters.ts:32` |

So today a `Dashboard` record stores **layout + text + metric specs + dashboard filters** by value,
and **everything about a chart** by reference. `src/dashboards.ts:16-18` says so explicitly: a
dangling `visualId`/`datasetId` "is handled gracefully at render time (the card shows a
placeholder)".

That gives four candidate meanings of "snapshot", and only one of them is the right one:

| what publish copies | survives an analysis edit? | survives a visual edit? | survives a dataset edit? | cost |
|---|---|---|---|---|
| (a) nothing new — dashboard keeps `visualId` | yes (sheets are already separate) | **no** | no | zero |
| (b) **+ the Visual definition, by value** | yes | **yes** | no | one new card shape |
| (c) + the dataset's Parquet | yes | yes | yes | duplicates up to 1M rows *per publish* |
| (d) + the rendered numbers | yes | yes | yes | violates the strict-number rule — stored figures |

**(b) is the answer.** REASONED, and the reasoning is that the guarantee in the brief is scoped to
the *analysis*: "editing an analysis after publishing must NOT change the live dashboard". A
`Visual` shown on a sheet is part of what the author edits — if changing a chart's type from the
Visuals page silently reshapes a published dashboard, the guarantee is not a guarantee. A
*dataset* is not part of the analysis; refreshing a Postgres connection is a data event, and a
published dashboard that can never see new data is not what "publish" means in a BI tool. (d) is
not on the table at all — `src/ipc/dashboards.ts:22-25` states the number-accuracy rule the whole
app is built on, and a stored figure would break it.

**(c) is explicitly rejected and this is a stated non-guarantee, not an oversight.** A published
dashboard shows *current data* through a *frozen definition*. Write it on the publish confirmation
UI in Phase D.

---

## 2. Record shapes

Storage layout: `analyses/` becomes a fourth sibling of `datasets/`, `visuals/`, `dashboards/`
under `userData/projects/<projectId>/`, one `<analysisId>.json` per record. Same conventions,
copied verbatim from `src/dashboards.ts` — the dual-UUID guard (`UUID_RE` on *both*
`projectId` and record id before either touches a path), atomic temp-sibling-then-`rename` writes
with a per-write `randomUUID()` suffix, `normalize()` re-sanitising every stored field on load, and
a corrupt/unreadable file being skipped rather than fatal.

### 2.1 `Analysis` (new — `src/analyses.ts`)

```ts
import type { Page } from './dashboards';
import type { FilterStep } from './transforms';

export interface Analysis {
  id: string;                       // generated UUID — never derived from the name; it is a path
  projectId: string;                // denormalised on load like Dashboard.projectId, never trusted from the file
  name: string;

  /** REUSED VERBATIM from dashboards.ts. A Page IS a sheet — see §2.4. */
  sheets: Page[];                   // always ≥ 1, same invariant sanitizePages() enforces

  /** Analysis-wide cross-visual filters. Identical semantics to Dashboard.filters:
   *  filter-only steps, merged card-side by dashboardFilters.mergeDashboardFilters. */
  filters: FilterStep[];

  /** Every dashboard this analysis has ever published, newest last. Republish targets
   *  an id in this list; a stale id (dashboard deleted) is dropped on load, not fatal. */
  publishedDashboardIds: string[];

  createdAt: string;
  updatedAt: string;                // bumped by any sheet/filter/name edit
  lastPublishedAt: string | null;   // null until first publish; drives the "unpublished changes" hint
  schemaVersion: 1;
}

export interface AnalysisSummary {
  id: string;
  name: string;
  sheetCount: number;
  publishedCount: number;
  updatedAt: string;
  lastPublishedAt: string | null;
}
```

Field justification, one line each:

- `id` / `projectId` — the dual-UUID path guard needs both, and `projectId` is re-supplied by the
  loader rather than read from the file (`src/dashboards.ts:253` does exactly this) so a hand-edited
  file cannot point a record at another project.
- `sheets` — the whole point of the split. Typed as `Page[]` so `sanitizePages` is reused unchanged.
- `filters` — the analysis is where you *set* a cross-visual filter; publishing copies the resolved
  list onto the dashboard. Keeping the same `FilterStep[]` type means `mergeDashboardFilters`,
  `sanitizeDashboardFilters` and every downstream `applyPipeline` path work with no new code.
- `publishedDashboardIds` — the brief asks for it, and it is the only way "republish to the same
  dashboard" can be an option rather than a free-text id the renderer supplies. It is provenance,
  not ownership: deleting an analysis must not delete its dashboards (§7, open question 9).
- `lastPublishedAt` + `updatedAt` — together they answer "does this analysis have unpublished
  changes?" without diffing. Cheap, and the alternative (a `dirty` boolean) goes stale.
- `schemaVersion: 1` — literal type, matching `Dashboard`'s `schemaVersion: 2` / `Visual`'s
  `schemaVersion: 2`, so a mismatched value is a compile error rather than a runtime surprise.

Deliberately **absent**: `visuals`, `datasets`. An analysis owns neither (Decision 1). Also absent:
a `layout` or `gridCols` field — `dashboards.GRID_COLS = 12` is already the single exported source
(`src/dashboards.ts:33`, asserted by `test-dashboards.ts:45`) and a second one would drift.

### 2.2 `Dashboard`, at schema v3 (`src/dashboards.ts`)

```ts
export interface Dashboard {
  id: string;
  projectId: string;
  name: string;
  pages: Page[];                    // the PUBLISHED SNAPSHOT. Not an editing surface any more.
  filters: FilterStep[];

  /** NEW. Provenance. null = a legacy standalone dashboard, or one created before
   *  its analysis existed. Never used to RESOLVE anything at render time — a
   *  published dashboard must render with the analysis deleted. */
  analysisId: string | null;

  /** NEW. When this snapshot was taken. null on a legacy record. */
  publishedAt: string | null;

  createdAt: string;
  updatedAt: string;
  schemaVersion: 3;                 // was 2
}
```

`analysisId` is provenance **only**. If it ever becomes a lookup — "load the analysis to render the
dashboard" — the snapshot guarantee is gone and this whole document was pointless. Phase C should
put that sentence in the file as a comment.

### 2.3 `Card`, with an inline visual snapshot

```ts
/** A by-value copy of a Visual's DEFINITION, taken at publish time.
 *  Not a copy of its data — every figure is still recomputed on open. */
export interface CardVisual {
  datasetId: string;
  name: string;                     // the title the card shows; Visual.name at publish time
  chartType: string;
  encoding: VizEncoding;            // import type { VizEncoding } from './visuals'
  overrides: VizOverrides;
  filters: FilterStep[];            // the visual's OWN filters, merged behind the dashboard's
}

export interface Card {
  id: string;
  type: CardType;
  layout: CardLayout;

  /** Authoring-time REFERENCE. Present on analysis sheets and legacy dashboards. */
  visualId?: string;

  /** Publish-time SNAPSHOT. When present it WINS and visualId is never resolved. */
  visual?: CardVisual;

  heading?: string;
  text?: string;
  metric?: CardMetric;
}
```

Precedence, non-negotiable: **`visual` present ⇒ render from it and never call `visuals.getVisual`.**
A published card keeps its `visualId` too, but only as (i) the republish source and (ii) a
"open the source visual" affordance. Nothing on the render path may read it.

Three consequences Phase C must handle, all of them REASONED from the code as it stands:

1. **`sanitizeCard` currently drops a visual card with no valid `visualId`** —
   `src/dashboards.ts:174-178`, `if (!isValidId(o.visualId)) return null;`. That rule must become
   "a visual card needs a valid `visualId` **or** a well-formed `visual`". This is a security
   whitelist, not a formatter: the new branch has to sanitise `CardVisual` as hard as
   `sanitizeEncoding`/`sanitizeOverrides`/`sanitizeFilters` do, by **calling those exact
   functions** out of `src/visuals.ts` rather than reimplementing them. Duplicating a whitelist is
   how whitelists drift.
2. **That means `dashboards.ts` gains a value import of `visuals.ts`.** The comment at
   `src/dashboards.ts:241` currently boasts that it needs no such import. There is **no cycle** —
   `visuals.ts` imports `fs/path/crypto/electron` + `projects` + `datasets` + `transforms` and
   never `dashboards` (READ-FROM-CODE, `src/visuals.ts:13-20`) — so take the import and update the
   comment. The alternative (hoist the three sanitisers into a shared module) is more churn for the
   same result and would move code every existing visuals test loads.
3. **`dashboard:explainAnomalies` resolves a card's dataset via `visuals.getVisual(projectId,
   card.visualId)`** (`src/ipc/dashboards.ts:503`). On a published card that becomes
   `card.visual.datasetId` — strictly better (no disk read) — but both paths must be kept, because a
   legacy dashboard has no inline spec.

### 2.4 `Page` is already a sheet — confirmed, with evidence

The brief's note is right and I found no reason to disagree.

`Page = { id: string; name: string; cards: Card[] }` (`src/dashboards.ts:60-64`), laid out on a fixed
12-column grid (`GRID_COLS`, `sanitizeLayout` clamping `x + w ≤ 12`), with the renderer already
shipping multi-page tabs, add / rename / remove, and per-page card grids
(`renderer/hub/dashboards.ts:317 renderDashPages`, `:357 handleAddPage`, `:367 handleRenamePage`,
`:376 handleRemovePage`, `:406 renderDashGrid`). Dashboard-wide filters already span pages. There is
nothing in a QuickSight sheet, at this feature's scope, that `Page` does not have.

**So this feature is not "add sheets".** Introducing a parallel `Sheet` type would fork
`sanitizePage`/`sanitizePages`/`sanitizeCards`/`sanitizeLayout` and the ~15 assertions in
`test-dashboards.ts` that pin them, and buy nothing. Reuse `Page`; call the field `sheets` in
`Analysis` and `pages` in `Dashboard`, because those are the words the two surfaces use.

One real gap, named rather than hidden: **`Page` has no per-sheet filters.** QuickSight sheets have
sheet-level controls. Out of scope here; if it is ever wanted, it is an additive
`filters?: FilterStep[]` on `Page` plus one more argument to `mergeDashboardFilters`.

---

## 3. Decision 1 — visuals stay project-level

**Decision:** visuals stay in `userData/projects/<id>/visuals/`, project-scoped, referenced by id
from analysis sheets. Publishing copies the definition by value into the card.

**Argued from the code:**

- Moving them under an analysis rewrites the *entire* visuals surface: `src/visuals.ts`'s path
  layout, all eight `visual:*` channels (`src/ipc/visuals.ts:152-219`), the preload bridge, the
  renderer Visuals page, `dashboard:draft`'s `listVisuals` inventory
  (`src/ipc/dashboards.ts:381,403`), and the four test files that drive them
  (`test-visuals.ts`, `test-viz-filter.ts`, `test-vizRewire.ts`, and the smoke test's saved-visual
  step). Every existing dashboard's `visualId` would dangle.
- **And it would not deliver the guarantee anyway.** An analysis-owned visual is still mutable from
  inside the analysis, so publish would *still* have to copy by value. Moving the files buys nothing
  the copy does not already buy, and costs the whole surface. That is the argument, and it is the
  reason to stop here.
- Keeping them project-level preserves the thing that is genuinely useful: one visual on several
  sheets, and on several analyses, edited in one place.

**What it costs, honestly:**

- **An analysis is not self-contained.** A visual it shows can be edited — or deleted — from the
  Visuals page by someone who never opened the analysis. While unpublished, the analysis just
  changes under them; that is the same behaviour dashboards have today, so it is not a regression,
  but it is not QuickSight either.
- **A published card and its source visual drift silently.** After publish, improving the visual
  does nothing to the dashboard until republish. That *is* the feature, and it will still read as a
  bug to a user who does not know the model. Phase D needs an "N cards differ from their source"
  hint on the analysis, or at minimum a republish prompt.
- **`Card` becomes a two-shaped record.** Every consumer grows a branch: `renderVisualCard`
  (`renderer/hub/dashboards.ts:585`), `buildVisualExportCard` (`:1331`), the anomalies dataset walk
  (`src/ipc/dashboards.ts:499-507`), and `sanitizeCard`.
- **A deleted visual no longer breaks a published dashboard.** Today the card renders "Source
  removed" (`src/dashboards.ts:16-18`); with an inline spec it keeps rendering. That is an
  improvement, but it is a *behaviour change*, and it only applies to cards published after this
  lands — legacy dashboards keep the placeholder.

---

## 4. Decision 2 — existing standalone dashboards survive

**Decision:** yes, and they are never migrated by a read. A pre-existing dashboard keeps working
exactly as today, is wrapped in an implicit `Analysis` **the first time the user edits it**, and the
wrap is one-way.

### 4.1 What triggers it

Not a read. Not `dashboard:list`. Not `dashboard:get`. The trigger is the explicit user action
"edit this dashboard", i.e. one new channel `analysis:forDashboard`, called by the renderer when the
user opens a legacy dashboard for editing.

This mirrors the precedent the brief names, `src/datasets.ts`, and its stated rule at lines 315-317:
*"Deliberately does NOT hydrate and does NOT migrate. Migration is a write, and a metadata read must
stay a read."* `getDatasetMeta` obeys it; `getDataset` migrates because it is already doing the full
work. The dashboard analogue is: listing and rendering are reads, editing is a write.

### 4.2 What it writes

1. Load the dashboard (dual-UUID guarded). If `analysisId` is already set and that analysis loads,
   return it — idempotent, exactly like `getDataset`'s second read.
2. Create `Analysis { name: <dashboard name>, sheets: <deep copy of pages>, filters: <copy>,
   publishedDashboardIds: [dashboardId], lastPublishedAt: <dashboard.updatedAt> }`, atomic write to
   `analyses/<newId>.json`.
3. Only if that write succeeded, `updateDashboard` to stamp `analysisId` + `publishedAt` and
   `schemaVersion: 3`. Parquet-first-JSON-second ordering, for the same reason
   `src/datasets.ts:141-144` gives: if step 3 fails you are left with an orphan analysis and an
   unwrapped dashboard, and the next edit retries cleanly. The reverse order would point a dashboard
   at an analysis that does not exist.
4. Best-effort: a failure at step 2 or 3 must **not** fail the user's action. Fall back to the
   legacy in-place dashboard editor and log. `src/datasets.ts:364-371` is the pattern.

Orphan analyses from a step-3 failure are the one piece of litter this design creates. They are
invisible (nothing lists an analysis with no dashboard and no user edit) and small (a JSON file).
Accept it; do not add a GC.

### 4.3 The bridge gate — the brief is wrong here, and this is the loud bit

The brief says to "gate on the bridge being available, exactly like the v2→v3 dataset migration".
**Do not.**

`src/datasets.ts` gates on `parquetStore.isSupported()` for one specific reason, stated at lines
122-126: the *target format of that migration is Parquet*. On a machine where the native module
fails to load, migrating would write a table the app cannot read back — hence "the app degrades to
'exactly as before' rather than to 'your data is gone'".

An `Analysis` record is plain JSON, like `project.json`, `visual.json` and `dashboard.json`. It
touches no Parquet, no DuckDB, no `queryAsync`. Gating it on the bridge would mean a user whose
native module failed to load — the exact user the gate exists to protect — **cannot author an
analysis at all**, for zero benefit. The correct gate is the one that already exists everywhere in
this store layer: the atomic write either succeeded or it did not.

(Note also that the whole workspace is *already* usable without the bridge — `parquetStore.isSupported()`
false just means v2 inline rows, `residentQuery.isResident()` false just means the JS path.
Introducing the first bridge-gated *authoring* feature would be a new class of degradation.)

### 4.4 A v1/v2 record that is only read

`normalize()` upgrades in memory and writes nothing — this is already how v1→v2 works for
`Dashboard.filters` (`src/dashboards.ts:260`, *"absent (v1) → []"*, pinned by
`test-dashboards.ts:194-203`). Extend it: absent `analysisId` → `null`, absent `publishedAt` →
`null`, `schemaVersion` → `3` in the returned object. `listDashboards` and `getDashboard` stay pure
reads. The file on disk remains v2 until something writes it.

**Cost of Decision 2:** a `Dashboard` now means two different things depending on `analysisId`, and
the renderer has to tell the user which one they are looking at. Editing a published dashboard
directly must be closed off (see §7 open questions 2 and 10) or the snapshot is not stable — the
current editor autosaves on a 600 ms debounce (`renderer/hub/dashboards.ts:860-866`), which would
quietly overwrite a snapshot the moment someone nudges a card.

---

## 5. `draftDashboard` — supersede, and delete the channel

**Decision: supersede.** `dashboard:draft` is removed and replaced by `analysis:draft` in
`src/ipc/analyses.ts`. Not aliased, not deprecated-but-live. The brief names the failure mode
correctly: two AI paths that both create dashboards, differing subtly, is the worst outcome, and an
alias *is* that outcome.

**Why the target changes.** The existing handler (`src/ipc/dashboards.ts:378-459`) is genuinely good
and almost all of it survives: build an inventory from `getDatasetMeta` (metadata only — the comment
at `:387-391` records that it used to hydrate every dataset in the project), ask the model for
`{name, cards[]}` referencing names, resolve names→ids **in main**, verify each metric column
actually exists, clamp the aggregation to `DRAFT_AGGS`, assign the grid layout ourselves with the
flow packer, `sanitizeCards`, and return **without saving** so the renderer can confirm. Keep every
line of that. The only thing that changes is what it produces: `{ ok, name, sheets }` for an
*analysis*, not `{ ok, name, pages }` for a dashboard.

That is the right target because the AI's output is a first draft — the thing a user immediately
wants to edit. Drafting straight into a published dashboard would mean the AI's output arrives in
the one place the model says is immutable, and the user's first act would be to trigger the
implicit-analysis wrap of §4 just to move a card.

**What happens to the pieces:**

| piece | fate |
|---|---|
| `dashboard:draft` channel | **deleted** |
| `hubPreload.ts:334 draftDashboard` | repointed to `analysis:draft` (name kept) |
| `globals.d.ts:224 draftDashboard(projectId)` | return type changes `pages` → `sheets` |
| `renderer/hub/dashboards.ts:962 handleDraftDashboard` | moves to the analysis surface; its `saveDashboard` call (`:993`) becomes `analysis:create` |
| `analyze.draftDashboard()` (`src/analyze.ts:819`) | **name kept**, body unchanged |
| `DRAFT_DASHBOARD_SYSTEM_PROMPT` | unchanged |
| the flow packer + name resolution | moved verbatim into `src/ipc/analyses.ts` |

Keeping `analyze.draftDashboard()`'s name is deliberate: it is the *model call*, it sits beside
`summarizeDashboard`/`explainAnomalies` which are unaffected, and renaming it would churn
`src/analyze.ts` for no user-visible meaning. **Phase E must extend this function, not add a
second one.** If Phase E needs a richer prompt, change `DRAFT_DASHBOARD_SYSTEM_PROMPT` and the
resolution step; do not introduce `draftAnalysis()` alongside it.

`dashboard:summary` and `dashboard:explainAnomalies` stay where they are, on the dashboard —
they narrate a finished artifact, which is what a reader looks at. Whether an *unpublished* analysis
should also be summarisable is open (§7, question 3).

---

## 6. IPC surface

New file `src/ipc/analyses.ts`, one `register()` with no deps object (pure disk + `analyze`),
matching `projects.register()` / `visuals.register()` / `dashboards.register()`. Every handler is
`ipcMain.handle`; a throw becomes `{ ok:false, error }` so the renderer never sees an unhandled
rejection. Wired in `main.ts` next to `require("./src/ipc/dashboards").register();` (line 587).

| channel | payload → result | notes |
|---|---|---|
| `analysis:list` | `{projectId}` → `AnalysisSummary[]` | newest-updated first, corrupt files skipped |
| `analysis:get` | `{projectId, id}` → `Analysis \| null` | pure read, never migrates |
| `analysis:create` | `{projectId, name, sheets?, filters?}` → `Analysis \| {ok:false,error}` | `sheets` optional so `analysis:draft` can hand its packed sheets straight in |
| `analysis:rename` | `{projectId, id, name}` → `{ok, analysis}` | |
| `analysis:update` | `{projectId, id, name?, sheets?, filters?}` → `{ok, analysis}` | mirrors `dashboard:update` exactly — full array replace, not a patch-merge |
| `analysis:delete` | `{projectId, id}` → `{ok}` | does **not** touch published dashboards |
| `analysis:publish` | `{projectId, id, dashboardId?, name?}` → `{ok, dashboard}` | §6.1 |
| `analysis:draft` | `{projectId}` → `{ok, name, sheets}` \| `{ok:false, notReady:true}` | moved from `dashboard:draft`; still returns WITHOUT saving |
| `analysis:forDashboard` | `{projectId, dashboardId}` → `{ok, analysis, created:boolean}` | the §4 implicit wrap; idempotent |

Changes to **`src/ipc/dashboards.ts`**:

- `dashboard:draft` — **deleted**.
- `dashboard:explainAnomalies` — the dataset-id walk reads `card.visual.datasetId` when present,
  falling back to `visuals.getVisual(card.visualId)`.
- `dashboard:metric`, `dashboard:save/:update/:get/:list/:delete`, `dashboard:summary` — unchanged.
  `save`/`update` remain for legacy standalone dashboards and for `analysis:publish` to call
  internally.

Changes to **`src/ipc/visuals.ts`**: none. A published card carries `datasetId`, `encoding` and
`filters` inline, which is precisely the payload `visual:data` already takes
(`src/ipc/visuals.ts:193`) — **no new charting IPC is needed**, which is the same property that
made metric cards free in Week 9.

Changes to **`src/ipc/dashboardExport.ts`**: none. The bundle is assembled in the renderer and
`sanitizeBundle` never saw a `visualId`.

Preload: `preload/hubPreload.ts` gains the nine mirrors; `renderer/hub/globals.d.ts` the types. No
new `BrowserWindow` — the analysis surface is a workspace section like Dashboards, per the
"settings/about/permission are inline panels, never a new window" rule.

### 6.1 `analysis:publish`, step by step

1. Guard both ids as UUIDs; load the analysis.
2. Deep-copy `sheets` → `pages`. **Keep each card's existing `id`** — a stable card id across
   republishes is what a future "what changed since last publish" diff needs, and a card id is a
   key, never a path (`src/dashboards.ts:51`).
3. For every `type: 'visual'` card: `visuals.getVisual(projectId, card.visualId)`; on success attach
   `card.visual = {datasetId, name, chartType, encoding, overrides, filters}` and keep `visualId`.
   **On failure keep the card as `visualId`-only** so it renders the existing "Unavailable"
   placeholder. Dropping it would silently reflow the layout, which is worse than a visible gap.
4. Copy `filters` by value.
5. If `dashboardId` is supplied **and is in `publishedDashboardIds`** → `updateDashboard` (republish
   in place, same id, name preserved unless `name` given). Otherwise `saveDashboard` and append the
   new id. Rejecting a `dashboardId` that is not in the list is what stops one analysis from
   overwriting another's dashboard.
6. Stamp `publishedAt` + `analysisId` on the dashboard, `lastPublishedAt` on the analysis.
7. Return the dashboard.

Nothing in this loop touches a row, hydrates a dataset, or computes a figure.

---

## 7. What must not regress

Exhaustive, with the check that would catch each. Test paths are absolute; the house harness is a
plain `ok(label, cond)` per script, so the "test name" is the label string.

| # | behaviour | caught by |
|---|---|---|
| 1 | Dashboard save/get/update/delete round-trip, name trimming, `createdAt === updatedAt` on save | `/Users/ashishb/Projects/ordinate-pA/scripts/test-dashboards.ts:63-133` |
| 2 | `schemaVersion` literal on a saved dashboard | `test-dashboards.ts:67, 176, 203` — three assertions pin the value `2`, including the v1-upgrade one. **All three need updating to 3; do it deliberately, in the same commit as the type change** |
| 3 | `sanitizeCard` drops every garbage card shape (unknown type, non-UUID `visualId`, bad aggregation, empty text card) | `test-dashboards.ts:136-153` `sanitize drops every garbage card, keeps the one valid card` — **the highest-risk assertion in this feature**; §2.3 changes the rule it pins |
| 4 | `sanitizeLayout` clamping (`x+w ≤ 12`, negative `y`, `h < 1`) and `GRID_COLS === 12` | `test-dashboards.ts:45, 93-102` |
| 5 | `sanitizePages` — a dashboard always has ≥ 1 page | `test-dashboards.ts:71, 108, 132` |
| 6 | Dual-UUID path-traversal guard on list/get/update/delete, incl. the two sentinel-file assertions | `test-dashboards.ts:213-235` — **`src/analyses.ts` needs the identical block** |
| 7 | v1 dashboard (no `filters`) still loads and normalises to `[]` | `test-dashboards.ts:194-203` — extend with a v2 record and assert `analysisId === null`, `publishedAt === null`, **and that the file on disk is still v2** |
| 8 | Dashboard filters persist, drop non-filter steps, survive reload, replace on update | `test-dashboards.ts:156-190` |
| 9 | Cross-visual filter merge: dashboard-first order, byte-identical de-dupe, non-filter steps dropped | `/Users/ashishb/Projects/ordinate-pA/scripts/test-dashboardFilters.ts:44-63` |
| 10 | One filter spans heterogeneous datasets — a filter on a missing column is skipped, total unchanged | `test-dashboardFilters.ts:95-102` |
| 11 | Filters change a *visual* card's aggregate (650 → 300 → 100 composition) | `test-dashboardFilters.ts:75-86` |
| 12 | Leading-zero strings survive filtering (`'007'` stays `'007'`, column stays `text`) | `test-dashboardFilters.ts:107-115` |
| 13 | **`sanitizeBundle` secret exclusion** — sentinel `SECRET-apiKey-abc123XYZ` planted in a top-level key, a chart-card key, a metric-card key and an unknown card kind; asserted absent from the whole HTML | `/Users/ashishb/Projects/ordinate-pA/scripts/test-dashboardExport.ts:105, 109-113` |
| 14 | Export references **no** http(s) URL, no external `<script src>`, no external stylesheet | `test-dashboardExport.ts:77-78, 102` |
| 15 | Only `data:image/…;base64,` survives as an image | `test-dashboardExport.ts:96` + the global http(s) regex at `:102` |
| 16 | A non-number chart value is coerced to `null` (never leaks a string into chart data) | `test-dashboardExport.ts:118-121` |
| 17 | Chart.js UMD is inlined from disk, never fetched | `test-dashboardExport.ts:76` (fake-UMD marker) |
| 18 | Metric semantics: empty ≠ 0, all-empty → `null` not `NaN`, `count` includes text, text column → `null`, no implicit `'007'` → 7 cast | `/Users/ashishb/Projects/ordinate-pA/scripts/test-metricValue.ts:33-101` |
| 19 | The resident metric path is actually taken above 1,000 rows, **and the table is never hydrated** | `/Users/ashishb/Projects/ordinate-pA/scripts/test-metricRewire.ts:369` `above threshold: NOT hydrated (resident branch taken)` (`getDataset` spy at `:94-100`); plus `:414` "3 metric cards on one small dataset hydrate it exactly once" |
| 20 | Resident metric === JS metric, `Object.is`, all five aggregations | `test-metricRewire.ts:178-188` |
| 21 | `visual:data` resident output is byte-identical to `buildVizData` incl. **cell types** and warnings | `/Users/ashishb/Projects/ordinate-pA/scripts/test-vizRewire.ts:130-136`; path pinned by `expectFast` at `:138-141` |
| 22 | `buildVizData` shape contract, pivot/`null` holes, filters-before-aggregation, geo derivation | `/Users/ashishb/Projects/ordinate-pA/scripts/test-vizData.ts:39-249` |
| 23 | Visual-level filters + overrides survive save/reload/duplicate independently | `/Users/ashishb/Projects/ordinate-pA/scripts/test-viz-filter.ts:86-135` — **`CardVisual` must round-trip the same fields; add a differential assertion that an inlined spec equals its source `Visual`** |
| 24 | **28 chart types**, each classified exactly once, each with a chip label | `/Users/ashishb/Projects/ordinate-pA/scripts/test-plotSpec.ts:62` `the id list under test is the real one` (`everyType.length === 28`), `:64-89` — this file `vm`-executes the real `renderResult.js`, so it is the only one that can catch a list change |
| 25 | Every `VIZ_LABELS` type has an icon | `/Users/ashishb/Projects/ordinate-pA/scripts/test-viz-icons.ts:46-48` |
| 26 | Chart eligibility minimums, small multiples, value labels, palette | `test-more-charts.ts`, `test-small-multiples.ts`, `test-value-labels.ts`, `test-palette.ts` — **caveat: these four MIRROR the renderer helpers rather than loading them, so they cannot catch a change to the real source.** Do not treat them as a safety net for a renderer edit |
| 27 | v2→v3 dataset migration: every cell verbatim, `'007'` stays text, `''` ≠ `null`, JSON drops `rows`, idempotent, no temp files | `/Users/ashishb/Projects/ordinate-pA/scripts/test-datasetsMigration.ts:82-123, 206` |
| 28 | Row cap: a **1,000,000-row** dataset saves, is Parquet-backed, aggregates in < 2,000 ms, pages in < 2,000 ms, leading zeros stay text | `/Users/ashishb/Projects/ordinate-pA/scripts/smoke-app.ts:183-201` |
| 29 | The real app opens a project and lists a dataset **from the rendered UI** | `smoke-app.ts:225-254` |
| 30 | **Zero renderer console errors, incl. CSP violations** — the check that caught the inline-style regression 2,400 assertions missed | `smoke-app.ts:435` `no renderer errors (incl. CSP violations)` (listeners at `:64-68`) |
| 31 | vgplot renders an SVG with marks and injects no `<style>`; MapLibre renders a GL canvas with DOM markers | `smoke-app.ts:329-368, 377-417` |
| 32 | The Svelte island stays unmounted by default | `smoke-app.ts:261-266` |
| 33 | Every `var(--x)` in the CSS resolves | `/Users/ashishb/Projects/ordinate-pA/scripts/test-cssVars.ts:118` |
| 34 | No inline `style=` in hub HTML (hub CSP) | only `smoke-app.ts:435` sees this — there is no static check |
| 35 | Copilot dashboard FACTS are app-computed and the model narrates only | `/Users/ashishb/Projects/ordinate-pA/scripts/test-copilot.ts` (`copilot.dashboardFacts`) |
| 36 | Anomaly detection is pure and the resident path matches it | `test-anomalies.ts`, `test-anomaliesResident.ts` |

**Gaps in the existing net that this feature makes more dangerous** (all READ-FROM-CODE, all
confirmed absent):

- **No test asserts the dashboards store's atomic write** (`src/dashboards.ts:123-131`). The only
  temp-file assertion is `test-datasetsMigration.ts:206`, and it covers `datasets/`.
- **No test plants a corrupt `dashboards/*.json`** and asserts `listDashboards` skips it. The
  filename guard at `src/dashboards.ts:289` is tested; the JSON-parse guard is not.
- **No test asserts `getDatasetMeta` leaves a v2 record unmigrated.** `getDatasetMeta` appears
  exactly once in `scripts/` (`smoke-app.ts:111`, reading `meta.resident`). Since §4.1 rests
  entirely on "a read must stay a read", **Phase C must add that assertion for both stores.**
- **No test asserts the IPC channel set or the preload bridge surface.** Two files stub
  `ipcMain.handle` to capture a single channel (`test-metricRewire.ts:55`, `test-vizRewire.ts`), but
  nothing enumerates. A channel added to `main.ts` and forgotten in preload fails nothing. Deleting
  `dashboard:draft` while leaving `hubPreload.ts:334` pointing at it would be silent.

**The three tests Phase C must add** (they do not exist in any form):

1. **The snapshot proof.** Publish → mutate the analysis (add a card, change a filter) → mutate the
   source `Visual` (`visual:update` chartType + encoding) → re-read the dashboard → assert
   `JSON.stringify(pages)` and `filters` are byte-identical to the publish return, and assert the
   inlined `card.visual.chartType` is the *old* value.
2. **The no-resolve proof.** Spy on `visuals.getVisual` the way `test-metricRewire.ts:94-100` spies
   on `datasets.getDataset`; assert it is called **zero** times while rendering a published card
   that carries an inline `visual`, and once for a legacy `visualId`-only card.
3. **The read-stays-a-read proof.** Load a legacy v2 dashboard via `dashboard:list` and
   `dashboard:get`; assert the returned object reports v3 defaults **and** that the bytes on disk are
   unchanged.

---

## 8. Open questions and risks

Settled from code where possible; the rest are named, not papered over.

1. **Is a published dashboard editable at all?** Recommendation: no — read-only, with "Edit in
   analysis". If it stays editable, the 600 ms autosave debounce
   (`renderer/hub/dashboards.ts:860-866`) will overwrite snapshots by accident, and republish will
   silently discard direct edits. **Not settled; it is a product call and it blocks Phase D's UI.**
2. **Concurrent write on a republish.** `analysis:publish` calls `updateDashboard` while a dashboard
   editor may be autosaving the same file. The atomic write degrades this to last-writer-wins with a
   whole valid file (`src/dashboards.ts:126-129`), so nothing corrupts — but a snapshot can be
   clobbered. Closing question 1 as read-only closes this too.
3. **`dashboard:summary` / `dashboard:explainAnomalies` on an unpublished analysis.** Both take a
   `dashboardId` today. Either add `analysis:summary`/`analysis:explainAnomalies` (two more AI paths
   — the exact thing §5 argues against) or accept "summarise after publishing". Leaning to the
   latter. Unsettled.
4. **Does Copilot get an `analysis` context?** `src/ipc/copilot.ts:29-57` dispatches on
   `dataset | visual | dashboard`. An analysis is the surface a user will be sitting in while asking
   questions. Adding a fourth kind needs a fourth `copilot.*Facts` builder. Not scoped here.
5. **Data freshness is deliberately not snapshotted** (§1). Needs explicit product sign-off, because
   it is the one place a user could reasonably expect "snapshot" to mean something stronger.
6. **Sheet-level filters do not exist** (§2.4). Additive later; naming it so nobody assumes they do.
7. **Presentation mode** (`renderer/hub/dashboards.ts:1252 enterDashPresent`) is renderer-only state
   on the dashboard editor. Which surface owns it after the split — probably the dashboard — is
   unspecified.
8. **`analysis:draft` and empty projects.** The existing guard refuses when a project has neither
   datasets nor visuals (`src/ipc/dashboards.ts:382-384`). An analysis draft with datasets but no
   saved visuals can only produce metric and text cards, which is a thin result. Worth a Phase E
   prompt change, not a Phase C one.
9. **Deleting an analysis must not delete its published dashboards.** Recommended, matching the
   existing "dangling references degrade gracefully" stance. The reverse — deleting a dashboard —
   should drop the id from `publishedDashboardIds` lazily on load, not eagerly.
10. **`CardVisual` is a snapshot of a mutable type.** If `Visual` grows a field (it went v1→v2 for
    `overrides` + `filters`), `CardVisual` must grow it too or published cards silently lose it.
    Mitigation: derive `CardVisual` as `Pick<Visual, 'datasetId'|'name'|'chartType'|'encoding'|'overrides'|'filters'>`
    so adding a field to `Visual` is at least visible at the copy site, and add an assertion that the
    inlined spec deep-equals the source at publish time (test #23 above).
11. **`CLAUDE.md` is materially stale, and Phase C will read it.** Verified against this worktree:
    it says maps are **Leaflet** — `package.json:55` has `maplibre-gl@^4.7.1` and
    `renderer/hub/mapRender.ts:1` is "Map rendering (MapLibre GL)"; it lists **Mosaic/vgplot and the
    Svelte renderer as "not built / out of scope"** — `src/ipc/mosaic.ts`, `renderer/hub/plotRender.ts`,
    `renderer/hub/svelte/`, `scripts/build-svelte.js`, `tsconfig.svelte.json` and
    `docs/phase-3c/README.md` all exist and ship behind `localStorage` flags; it says the entry point
    is `main.js` — the source is now `main.ts`; and it quotes **~3,000 assertions** against a measured
    **4,334**. None of this changes the decisions above, but a Phase C agent taking the "out of
    scope" list at face value could delete or duplicate live code. Fix it in a separate docs commit.

---

## 9. What I did not verify

- **Nothing here was benchmarked.** Publish is a JSON copy plus one `getVisual` per visual card; I
  assert no cost claim about it.
- **I did not run `npm run smoke`.** The claims about it are read from `scripts/smoke-app.ts`.
- **I did not read every renderer consumer of `Card`.** I found four resolution sites
  (`renderVisualCard`, `buildVisualExportCard`, the anomalies walk, `sanitizeCard`); there may be
  more in `renderer/hub/dashboards.ts`'s 1,400 lines. Phase C should grep `visualId` before
  starting, not after.
- **I did not confirm the renderer's dashboard editor can be made read-only cheaply.** Question 1
  assumes it can.
- **The 28-chart-type figure is `test-plotSpec.ts`'s, not mine.** I did not count `VIZ_LABELS`
  independently — it lists 28 entries by eye, and the test asserts
  `ALL_CHART_TYPE_IDS + 3 === 28`, which is the number that matters.
