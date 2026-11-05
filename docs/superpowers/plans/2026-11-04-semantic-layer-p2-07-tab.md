# Semantic layer part 2, PR 07: the Source tables tab — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Editors and admins get **Data model → Source tables**, laid out like Datasets. It has a "To fill in next" strip, a list grouped by connection with **+ Add**, and the picked table's **Overview · Columns · Guide**, with **Read from warehouse** and a guide editor. Connections links to it with **Document in Data model ↗**. Viewers never see the tab, and its address takes them to Datasets.
**Architecture:** A new tab inside part 1's `DataModelPage`, drawn from `sourceTable:list` and `sourceTable:get` (PR 03/04) and nothing else. Warehouse calls happen only on **+ Add** (`connection:listTables`) and **Read** (`sourceTable:read`). It reuses part 1's split, strip and markdown, and the app's edit guard. Routes carry `connId` and `docId`, never a name.
**Tech Stack:** React 19, React Router 7, TanStack Query, CSS Modules (tokens only), Vitest, Playwright (the fake warehouse, `seed.ts --live`).
**Spec:** docs/semantic-layer/02-source-tables.md ("What you will see", D3, D4, D5, the Connections link, "Tests that prove it": web, viewers, no warehouse on view, no name in a URL) · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p2-00-index.md
**Branch and PR:** `feat/semantic-p2-07-tab` off `origin/develop` after PR 04 **and part 1's step 10** (`feat/semantic-p1-10-data-model-section`) merge. One PR, in release 2.

## Global Constraints

- **Mockups before building (Task 1).** Code starts only after the owner has seen the six panel states in both themes.
- **Editors only.** Draw the tab when `useCanEdit(projectId)` (`web/src/features/projects/api.ts:127`). `?tab=sources` for a caller who cannot edit `<Navigate>`s to `?tab=datasets` with `replace`. That happens **only once `useRoles()` has resolved**. While roles are pending, show a skeleton, so an editor's deep link is never bounced. A viewer's web never calls a `sourceTable:*` channel (a 403 is a console error, and the e2e harness fails on one).
- **No name in a URL.** The params are `?tab=sources&conn=<connId>&doc=<docId>&panel=overview|columns|guide`. An undocumented used table is picked in component state, never the URL. Its panel shows Overview and a primary **Start its notes**, which saves the empty doc and then sets `doc=`.
- **No warehouse on view.** Opening the tab, the list, the strip, the panel and every tab reads records only. **+ Add**, **Read from warehouse** and **Read again** are clicks.
- **The UI derives no figure.** Row estimates go through `formatNumber` (`web/src/features/data/format.ts`), the size is the server's `facts.sizeLabel`, and times go through `ago` (`web/src/app/when.ts:16`).
- `web/src/app/routes.tsx` and `nav.ts` get no line. `DataModelPage.tsx` appends `'sources'` to `TABS` and draws its `Tab` second, after Datasets.
- Use part 1's `Model.module.css` classes (`split list item itemOn groupCap strip chip panel panelHead row`). New rules go in `sources/Sources.module.css`, tokens only, stacking under 900 px with no sideways scroll at 375 px. Keep a designed empty state, a skeleton and an `ErrorState` with Retry for every read.
- The RPC budget is 25 per load. The initial JS budget is ≤ 300 KB gzip: the tab is inside the `/model` lazy chunk.
- Every new file stays under 300 lines. `web/src/features/connections/WorkbenchPage.tsx` is 350 lines and gets one prop. `DetailsRail.tsx` is 278.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **An editor's deep link bounces to Datasets** because `useCanEdit` is false while roles load. Task 3's test renders with roles pending and then resolved.
- **The edit guard.** Saving the guide sends the open copy's tag as `base`. A 409 shows `ConflictBanner` and keeps the typed text. `GuardType` and `ConflictNoun` gain `'sourceTable'` / `'source table notes'` (`web/src/features/editConflicts/useEditGuard.ts:16`, `ConflictBanner.tsx:18`). Task 4.
- **Databricks.** Its **Read from warehouse** carries "Reading runs on the SQL warehouse and can start it." (`factsWake`). Task 4.
- **The list after a save.** Saving or reading refreshes `sourceTable:list` (the strip) and `sourceTable:get`. Task 4.
- **Connections' link creates a doc.** It is idempotent by exact name (PR 03), so clicking it twice opens one doc. Task 5.

## Rolling deploys

No stored change. A new browser on a pod without PR 03 gets "unknown channel" from `sourceTable:list`: the tab shows its `ErrorState` with Retry, and Datasets is untouched. An old browser has no tab.

---

### Task 1: Mockups (the gate)

**Files:** None in the feat branch. On the throwaway `docs/semantic-layer-design` worktree only, extend `web/src/features/model/prototype/LaterParts.tsx` `SourceTablesTab`. It is uncommitted there, as part 1 step 10's note says. Never copy a file from it.
- [ ] **Step 1:** Draw these states with the prototype's fake values:
  - the panel never read;
  - read (Overview with key, partition, cluster, size and "Read 3 days ago by sam");
  - stale (read 41 days ago);
  - a failed read (the error line + Retry);
  - not readable (a SaaS connection);
  - Databricks (the wake warning);
  - an undocumented used table (Overview + **Start its notes**);
  - the empty tab ("No source tables yet");
  - the **+ Add** picker.
- [ ] **Step 2:** Run `npm --prefix web run dev`. Take light and dark screenshots of each state at 1440 px and 375 px, and put them in the PR draft.
- [ ] **Step 3:** Wait for the owner's OK or changes. Note the decision in the PR description. Nothing is committed.

### Task 2: The API and the list

**Files:** Create `web/src/features/model/sources/api.ts`, `SourceTablesTab.tsx`, `SourceList.tsx`, `Sources.module.css`, `sources.test.tsx`. Modify `web/src/features/model/DataModelPage.tsx` (part 1: `TABS`, the `Tab`, the redirect) and `web/src/features/model/datasets/TodoStrip.tsx` (part 1).
**Interfaces:** Consumes `sourceTable:list` (PR 03), `TodoStrip`, `useCanEdit`, `useRoles`. Produces:
- `useSourceTables(projectId, on)` (key `['sourceTable:list', projectId]`, through `okOr`, as `web/src/features/data/api.ts:196-200` does), with types mirrored from PR 03 `SourceConn`, `SourceRow`, `SourceTodo`.
- `sourceTodoText(t: SourceTodo): string`. The wordings are:
  - `RETURNS: no doc`
  - `CUSTOMERS: no owner`
  - `public.orders: never read`
  - `ORDERS: no guide`
  - `FCT_SALES: read 41 days ago`

  `SourceTodo` gains no figure: the "41" comes from `ago(readAt)`.
- `TodoStrip`: if part 1 wrote it for `TodoItem` only, widen it to `TodoStrip({ items: { id: string; text: string }[]; more: number; onPick(id: string): void })`, keeping the `region` "To fill in next" and `+{more} more`. Leave `DatasetsTab`'s call and `model.test.tsx` unchanged and green.
- `SourceTablesTab({ projectId })`:
  - First, the line "Tables in your databases and warehouses that datasets are built from. Only editors of this project see this tab."
  - Then the strip, when `todo` is non-empty.
  - Then a split: a `nav` "Source tables" grouped by connection (`groupCap`: name and connector label), plus the panel.
  - Each item shows the table in mono, "N datasets" or "no doc", and a warn mark when `datasetIds.length > 0 && !docId`.
  - Each group has **+ Add** (Task 5's dialog).
  - The picked item is `?conn&doc`, else the first documented one. It carries `aria-current="true"`.
  - Empty: `EmptyState icon="database"` "No source tables yet", with "Datasets you import from a connection show their tables here. Add one from a connection." and a link "Open Connections" to `/connections/<p>`.
- [ ] **Step 1: Write the failing test.** `sources.test.tsx` uses `renderApp` and a `serve()`, as part 1's `model.test.tsx` does:
  - As an editor at `/model/P?tab=sources`, the tab list reads `['Datasets', 'Source tables', 'Metrics', 'Glossary', 'Relationships']`.
  - The groups read `['Warehouse', 'Shop DB']`, and `RETURNS` shows "no doc" with the warn mark.
  - The strip has 4 buttons and `+2 more`. Clicking `RETURNS: no doc` shows the h2 "RETURNS" with **Start its notes**, and the location has **no** `RETURNS`.
  - `sourceTable:list` answering `{ connections: [] }` shows "No source tables yet".
  - A 404 shows "Source tables could not be loaded", and Retry calls it twice.
  - NEGATIVE CONTROL: as a viewer, no "Source tables" tab, `?tab=sources` lands on `?tab=datasets`, and `sourceTable:list` is never called.
  - With roles pending, then resolved as an editor, `?tab=sources` stays.
- [ ] **Step 2: Run it to see it fail.** Run `npm run test:web -- sources`. Expect `Cannot find module './sources/SourceTablesTab'`.
- [ ] **Step 3: Implement.** Use the interfaces above.
- [ ] **Step 4: Run it to see it pass.** Run `npm run test:web -- sources model`, then `npm run lint`.
- [ ] **Step 5: Commit.** `git add web/src/features/model`. Message: "Add the Source tables tab with its list and what to fill in next".

### Task 3: The panel: Overview, Columns, and reading from the warehouse

**Files:** Create `web/src/features/model/sources/SourcePanel.tsx`, `SourceOverview.tsx`, `SourceColumns.tsx`, `panel.test.tsx`. Modify `api.ts` (+`useSourceDoc`, `useReadFacts`).
**Interfaces:** Consumes `sourceTable:get` and `sourceTable:read`. Produces `SourcePanel({ projectId, conn, row })`. Its head holds:
- the h2 (the table, mono);
- the connection's name with its `ConnLogo`;
- `Read <ago> by <who>` or "Never read";
- **Edit** (Task 4), plus **Read from warehouse** / **Read again** (a `Button` with `loading`) when `conn.readsFacts`.

The tabs are `?panel=` (`overview` by default, `columns`, `guide`; icons `info columns file-text`).
- **Overview** is a `dl` with these rows, in order. A row with no value is left out, except Owner, Refreshes and Required, which read "Not written yet":
  - Connection
  - Owner
  - Refreshes
  - Required (`requiredFilters`)
  - Primary key (with "(declared, not enforced)" when `enforced === false`)
  - Partitioned by (with "· queries must filter on it" when `required`)
  - Clustered by
  - Sort key
  - Distribution
  - Rows ("~" + `formatNumber(rowEstimate)` + " (the warehouse's estimate)" and ` · ${sizeLabel}`)
  - Last changed
  - Built from it (each dataset links to `/model/P?tab=datasets&dataset=<id>`)
- **Columns**: a table of Column (mono), Warehouse type, Comment, Key (an ok `Badge` "key"), from `doc.facts.columns`. Never read: an `EmptyState` "Not read from the warehouse yet", with the read button, or with "This source has no catalog Ordinate can read. Write its notes by hand." when `!readsFacts`. A failed read keeps the last facts and shows the server's sentence as `role="alert"` with Retry. A stale read (`readAt` > 30 days) shows a warn `Badge` "read 41 days ago".
- With `conn.factsWake`, the line "Reading runs on the SQL warehouse and can start it." sits beside the button.
- [ ] **Step 1: Write the failing test.** `panel.test.tsx`:
  - Overview row labels for the fixture equal `['Connection', 'Owner', 'Refreshes', 'Required', 'Primary key', 'Partitioned by', 'Clustered by', 'Rows', 'Built from it']`.
  - "LINE_ID (declared, not enforced)".
  - "~48,200,000 (the warehouse's estimate) · ~12.4 GB" comes from `rowEstimate: 48200000` and `sizeLabel: '~12.4 GB'`.
  - Columns shows the comment "Discount in USD, after tax" and one "key" badge.
  - Never read shows "Not read from the warehouse yet". Clicking Read sends exactly one `sourceTable:read`, and the list is refetched.
  - A refusal `{ ok: false, error: 'This connection’s tables were read 60 times…' }` shows that text as an alert and keeps the old columns.
  - `readsFacts: false` shows the by-hand sentence and no button.
  - `factsWake` shows the wake line.
  - A stale `readAt` shows "read 41 days ago".
  - NEGATIVE CONTROL: rendering every panel tab makes zero `sourceTable:read` and `connection:*` calls.
- [ ] **Step 2: Run it to see it fail.** Run `npm run test:web -- panel`. Expect a missing module.
- [ ] **Step 3: Implement.** Use the interfaces above.
- [ ] **Step 4: Run it to see it pass.** Run `npm run test:web -- panel sources`, then `npm run lint`.
- [ ] **Step 5: Commit.** `git add web/src/features/model/sources`. Message: "Show a source table's overview and columns, and read them from the warehouse on a click".

### Task 4: The guide and its editor

**Files:** Create `web/src/features/model/sources/SourceGuide.tsx`, `SourceDocForm.tsx`, `guide.test.tsx`. Modify `web/src/features/editConflicts/useEditGuard.ts:16` (`GuardType` += `'sourceTable'`) and `ConflictBanner.tsx:18` (`ConflictNoun` += `'source table notes'`).
**Interfaces:** Consumes `sourceTable:save` and `MarkdownView` (`web/src/features/dashboards/Markdown.tsx:74`, with `token={(n) => ({ text: `{{${n}}}`, missing: true })}`, as part 1's guide does), `useEditGuard({ projectId, type: 'sourceTable', id: docId }, tag)`.
- **Guide** renders `doc.guide` as markdown, with "Last edited by {updatedBy}, {ago}". With no guide it shows an empty state, "Write this table's guide: partitions, filters to always use, load times. Datasets built from it show it in their own Guide.", and a **Write guide** button.
- **Edit** (from the head or the Guide) opens `SourceDocForm`, a `Dialog` with Owner (≤ 80), Refreshes (≤ 200), Required filters (≤ 500) and Guide (a textarea ≤ 8,000, with the count shown). It saves through `guard.save((base) => rpc('sourceTable:save', { projectId, connId, docId, patch, base }))`. On success it invalidates `['sourceTable:get']` and `['sourceTable:list']`. A 409 shows `ConflictBanner` and keeps the typed text.
- [ ] **Step 1: Write the failing test.** `guide.test.tsx`:
  - `# Filter on ORDER_DATE` renders a heading.
  - Edit → type an owner → Save sends `sourceTable:save` with the open tag as `base` and the patch `{ owner: 'Data platform' }`, and the list is refetched.
  - A 409 `record_changed` shows the conflict banner and the field still holds the typed text.
  - The guide counter reads `8,000` at the cap and refuses more.
  - **Delete notes** (in the form, with a confirm) sends `sourceTable:delete` and the panel moves to the next table.
- [ ] **Step 2: Run it to see it fail.** Run `npm run test:web -- guide`.
- [ ] **Step 3: Implement.** Use the interfaces above.
- [ ] **Step 4: Run it to see it pass.** Run `npm run test:web -- guide panel sources editConflicts`, then `npm run lint`.
- [ ] **Step 5: Commit.** `git add web/src/features/model/sources web/src/features/editConflicts`. Message: "Write and edit a source table's guide, with edit conflicts".

### Task 5: + Add, and "Document in Data model ↗" on Connections

**Files:** Create `web/src/features/model/sources/AddSourceDialog.tsx`, `add.test.tsx`. Modify `web/src/features/connections/DetailsRail.tsx:225-227` (a link under the "Connection" heading), `WorkbenchPage.tsx` / `Results.tsx` (a link beside "Save as dataset" when a table is shown), `connections.test.tsx`.
**Interfaces:**
- `AddSourceDialog({ projectId, connId })` calls `connection:listTables` **when it opens** (a click), filters by a search box, and shows each `qualify(t)` (`web/src/features/connections/api.ts:129`), marking the ones already documented. Picking one sends `sourceTable:save { projectId, connId, table: qualify(t), patch: {} }`, then sets `?conn&doc`.
- `documentTable(projectId, connId, table)`: the same save, then `navigate(`/model/${projectId}?tab=sources&conn=${connId}&doc=${docId}`)`.
- The rail link "Document in Data model ↗" goes to `/model/<p>?tab=sources&conn=<connId>`. The Results link (when `shown.table`) calls `documentTable`.
- [ ] **Step 1: Write the failing test.** `add.test.tsx`:
  - Opening **+ Add** sends exactly one `connection:listTables`, and closing it sends none.
  - Picking `public.orders` sends a save with `table: 'public.orders'` and then shows its panel.
  - The URL has `doc=` and no `public.orders`.
  - Picking an already-documented table opens that doc (the server returns `created: false`).

  `connections.test.tsx`:
  - The rail has the link with that href.
  - With a table shown, "Document in Data model" saves and lands on `/model/P?tab=sources&conn=C&doc=D`.
- [ ] **Step 2: Run it to see it fail.** Run `npm run test:web -- add connections`.
- [ ] **Step 3: Implement.** Use the interfaces above.
- [ ] **Step 4: Run it to see it pass.** Run `npm run test:web`, `npm run lint` and `npm --prefix web run size` (≤ 300 KB).
- [ ] **Step 5: Commit.** `git add web/src/features/model/sources web/src/features/connections`. Message: "Add a source table from its connection, and link Connections to its notes".

### Task 6: One e2e, the viewer walk, the changelog

**Files:** Create `web/e2e/source-tables.e2e.ts`, started like `web/e2e/live.e2e.ts` with the live seed (`server.ts` `seedOpts.live`, the fake warehouse with `ORDINATE_TEST_LIVE_FAKE=1`). Modify `web/e2e/viewerRoutes.ts` and `CHANGELOG.md` (`[Unreleased]` → `### Data model`).
**Interfaces:** These are the e2e tests, each ending in `screens(page, 'model-sources…')` (light and dark):
1. **`source tables: document and read a warehouse table`**
   - Go to `/model/${pid}?tab=sources`. The strip leads with `live_fake_orders: no doc`.
   - Click it, then **Start its notes**, then **Read from warehouse**. Columns shows "Order amount in USD", the comment the fake's fixture stores.
   - Write the guide `## Always filter on day` and save. Overview's Built from it lists "Orders (live)".
   - Every `page.url()` seen under `/model` holds no `live_fake_orders` (collect them with `page.on('framenavigated')`).
   - Shots: `model-sources` and `model-sources-columns`.
2. **`source tables: from Connections`**
   - Open the workbench at `/connections/${pid}/${connId}?table=live_fake_orders`. That URL is the workbench's own, editor-only and unchanged.
   - Click "Document in Data model". You land on `/model/…&doc=…`, the same doc as test 1.
3. **No warehouse on view.** Reload the panel and walk Overview, Columns and Guide: the network log holds no `sourceTable:read` and no `connection:` call.

   `viewerRoutes.ts` adds `{ pattern: '/model/:projectId', url: (s) => `/model/${s.pid}?tab=sources`, editor: { role: 'tab', name: 'Source tables' } }`. The viewer must land on Datasets with no such tab.
- [ ] **Step 1: Write the failing test.** Write the spec above.
- [ ] **Step 2: Run it to see it fail.** Run `npm run build:web && npm --prefix web run e2e -- source-tables`.
- [ ] **Step 3: Implement.** Fix whatever the spec finds. Add the changelog line: "Data model has a Source tables tab for editors: the warehouse tables datasets are built from, their notes, and what the warehouse says about them, read on a click."
- [ ] **Step 4: Run it to see it pass.** Run `npm --prefix web run e2e -- source-tables model connections live` and `DATABASE_URL=… npm --prefix web run e2e -- view-only-routes`. Check every `model-sources*` shot in both themes against the house polish bar.
- [ ] **Step 5: Commit.** `git add web/e2e CHANGELOG.md`. Message: "Cover the Source tables tab end to end and in the viewer walk".

## Existing tests that must stay green

Web: `model.test.tsx`, `panel.test.tsx` (part 1), `connections.test.tsx`, `doors.test.tsx`, `navGroups.test.ts`, `dockRoute.test.tsx`, the edit-conflict tests. E2e: `model`, `connections`, `live`, `edit-conflicts`, `view-only-routes`. Size ≤ 300 KB, lint 0.
