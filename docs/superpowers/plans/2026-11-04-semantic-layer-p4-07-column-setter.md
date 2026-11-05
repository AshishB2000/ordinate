# Semantic layer part 4, step 07: the column access setter, the Access tab and what a viewer sees: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project admin chooses, on Dataset → Access, who sees each column: everyone, or only named users and teams. The server adds the columns computed from a hidden one and pins the steps that read it. A viewer it hides a column from sees the grid without it ("2 columns hidden"), the Fields tab with a lock, and the server's sentence where a figure would need it.
**Architecture:** Two admin channels, `dataset:columnAccess` and `dataset:setColumnAccess` (`src/api/columnAccess.ts`, `src/ipc/columnAccess.ts`), mirror `dataset:rowPolicy` and `dataset:setRowPolicy` (`src/api/rowPolicy.ts`, `src/ipc/rowPolicy.ts`). The setter writes through `serialized` under the record's lock, the same lock `writeRecordKeepingPolicy` takes. It stamps the rules with 05's `buildColumnAccess`. The web adds one section to the existing Access tab and reads 05's `hidden` flags in the grid and the Fields tab.
**Tech Stack:** `src/api`, `src/ipc`, `src/data`, `web/src/features/data`, `web/src/ui/DataGrid`, Playwright, `docs/server/row-level-security.md`, `CHANGELOG.md`.
**Spec:** docs/semantic-layer/04-governance.md ("What you will see", D12–D14, D22, D23) · Index: 2026-11-04-semantic-layer-p4-00-index.md
**Branch:** `feat/semantic-p4-07-column-setter` off `origin/develop` after 06 merges. **This is the last PR of release B**: nothing may set a rule before every reader enforces it.

## Global Constraints
- **Only a project admin reads or sets the rules** (`access: 'admin'`). The read is `audit: 'denials'`, like `dataset:rowPolicy`. The setter is audited by the route, as every admin call is (D23). Rules are not versioned. The audit log is their history.
- **An allow-list** (D12): `visibleTo` names users and teams of this org. Anyone not named, including someone added to the project later, does not see the column. An empty `visibleTo` hides the column from every viewer.
- **Server-stamped:** carriers (with `from`), `readersHash`, `updatedBy` (`catalog.osUser()`) and `updatedAt`. A carrier is never typed by the admin, and it is listed read-only.
- **Refused with a sentence, nothing stored:** a column the dataset does not have, a member who is not a user or team of this org (reuse `membersExist` from `src/ipc/rowPolicy.ts:51-65`, exported), more than `MAX_RULED_COLUMNS`, or no database (`no_database`, as row rules).
- Sentences go in a new `src/data/columnAccessMessages.ts` (added to `MAIN_FILES`). The web words its own labels in English.
- The Access tab is admin-only (`DatasetPage.tsx:318-322`). The grid note and the Fields lock show for anyone the server marked a column `hidden` for.
- RPC budget 25. The grid and Fields tab use `dataset:columns`, which they already fetch. The section's two calls are made only when the tab is open.

## Review Focus
- A refresh that races the setter keeps the rules (Task 1). This is D2b's guarantee, extended to `columnAccess`.
- An editor's view (the negative control) shows every column with no lock (Task 3).
- The negative control on the tab: an editor never sees the Access tab or its calls.

---

### Task 1: The two channels
**Files:** Create `src/api/columnAccess.ts`, `src/ipc/columnAccess.ts`, `src/data/columnAccessMessages.ts` · Modify `src/api/index.ts` (append `import { columnAccess } from './columnAccess'` and `...columnAccess,`), `src/server/app.ts:575` (register beside `../ipc/rowPolicy` with the pool), `src/ipc/rowPolicy.ts` (export `membersExist`), `scripts/i18n-extract.ts:375` · Test `scripts/test-columnSetter.ts` (on `scripts/columnAccessHarness.ts`)
**Interfaces:** Produces
```ts
const Member = z.union([z.strictObject({ userId: Uuid }), z.strictObject({ teamId: Uuid })]);
'dataset:columnAccess':    rpc({ access: 'admin', audit: 'denials', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId })
  // → { ok: true; rules: ColumnRule[]; state: AccessState | 'none'; suggest: string[] /* marked personal/financial, not hidden: sharePolicy.markedColumns */; builtFrom: { id; name }[] }
'dataset:setColumnAccess': rpc({ access: 'admin', input: z.strictObject({ projectId: Uuid, datasetId: Uuid,
    columns: z.array(z.strictObject({ column: z.string().min(1).max(256), visibleTo: z.array(Member).max(500) })).max(256).nullable() }), project: byProjectId })
  // → { ok: true; rules: ColumnRule[] } | { ok: false; error: string; code?: 'no_database' }
```
- `null` or `[]` deletes `columnAccess`.
- Otherwise, under `serialized(datasetFilePath(...), (raw) => …)`, every column must be in `raw.columns`. Then `raw.columnAccess = buildColumnAccess(raw, columns, osUser(), new Date().toISOString())`.
- Members are checked with one query per kind before the lock.
- `builtFrom` reuses `builtFrom` from `src/ipc/rowPolicy.ts:34-44` (export it): the datasets closed by it (D17 derived).
- [ ] **Step 1: Write the failing test**
```ts
const set = (who: string, columns: unknown) => W.call(who, 'dataset:setColumnAccess', { projectId: P, datasetId: STAFF, columns });
const r = await set('boss', [{ column: 'salary', visibleTo: [{ teamId: HR }] }]);
ok('the admin sets it; the carrier is added, read-only, from salary', r.body.ok && r.body.rules.some((x: ColumnRule) => x.column === 'bonus' && x.from === 'salary'));
ok('east is now refused sum(salary); hr is answered', H.refused(await W.call('east', 'visual:data', SUM_SALARY), 'hidden') && !H.refused(await W.call('hr', 'visual:data', SUM_SALARY)));
ok('an editor and a viewer are 403 on both channels', [await set('ed', []), await set('east', []), await W.call('ed', 'dataset:columnAccess', Q), await W.call('east', 'dataset:columnAccess', Q)].every((x) => x.status === 403));
ok('a column the dataset lacks is refused; nothing stored', !(await set('boss', [{ column: 'nope', visibleTo: [] }])).body.ok && (await stored()).columns.length === 2);
ok('a member of another org is refused', !(await set('boss', [{ column: 'salary', visibleTo: [{ teamId: FOREIGN_TEAM }] }])).body.ok);
ok('the read says pipeline after a new step reads salary, and suggests the marked column ssn', ((x) => x.state === 'pipeline' && x.suggest.includes('ssn'))((await afterStep(CALC_SALARY2, () => W.call('boss', 'dataset:columnAccess', Q))).body));
ok('a refresh racing the setter keeps the rules', await raceRefreshWithSetter());
ok('null removes them, and east is answered again', (await set('boss', null)).body.ok && !H.refused(await W.call('east', 'visual:data', SUM_SALARY)));
```
`raceRefreshWithSetter` holds a refresh of Staff between its fetch and its record write (the fake connector's fetch awaits a gate the test opens). It sets the rules, releases the refresh, and asserts the stored `columnAccess` equals what the setter wrote.
- [ ] **Step 2: Run it to see it fail.** `node scripts/check-contracts.js` reports `dataset:*ColumnAccess` unresolved.
- [ ] **Step 3: Implement.** Follow `src/ipc/rowPolicy.ts:67-117`.
- [ ] **Step 4: Run it to see it pass.** `node scripts/check-contracts.js && DATABASE_URL=… node scripts/test-columnSetter.js && DATABASE_URL=… node scripts/test-columnAccessSafetyNet.js && node scripts/i18n-extract.js && node scripts/test-i18n.js && node scripts/test-server-boot.js` report 0 unresolved and `ok`.
- [ ] **Step 5: Commit.** `git add src/api src/ipc/columnAccess.ts src/ipc/rowPolicy.ts src/data/columnAccessMessages.ts src/server/app.ts scripts/i18n-extract.ts src/i18n scripts/test-columnSetter.ts` · "Let a project admin choose who sees each column of a dataset"

### Task 2: Who sees each column, on the Access tab
**Files:** Create `web/src/features/data/columnAccessApi.ts`, `ColumnAccessSection.tsx`, `ColumnAccess.module.css`, `columnAccess.test.tsx` · Modify `web/src/features/data/DatasetPage.tsx:318-322` (the `access` panel renders `RowAccessTab` then `ColumnAccessSection`)
**Interfaces:** Consumes `dataset:columnAccess`/`:setColumnAccess`, the member picker `RowAccessTab` already uses for users and teams (`web/src/features/data/RowAccessTab.tsx`: reuse its component, or extract it into `MemberPicker.tsx` if it is inline). Produces `ColumnAccessSection({ projectId, datasetId, header })`:
- **Who sees each column.** One row per ruled column, `salary · Only: HR`, with an edit button that opens a member picker. Carriers read `bonus_pct · Only: HR (hidden too: computed from salary)`, with no edit. "Hide a column…" adds a row.
- A **suggestion line** for `suggest` columns: "ssn is marked personal. Hide it from viewers?", with a one-click add.
- The **state**: `pipeline` reads "A Prepare step that reads a hidden column changed. Viewers outside these lists can't open this dataset until you save the rules again." with **Save again**. `gone` names the column ("salary is no longer a column of this dataset…").
- `builtFrom` lists "Also closed to them: <names>".
- States: a skeleton while loading, a designed empty state ("Every column is visible to everyone who can open this dataset." with **Hide a column…**), and an error state with Retry. Both themes, tokens only.
- [ ] **Step 1: Write the failing test.** With a mocked reply holding `salary` (HR) and a carrier `bonus_pct`, the section renders both rows and "hidden too: computed from salary", and the carrier has no edit button. Picking a team and saving posts `{ columns: [{ column: 'salary', visibleTo: [{ teamId: HR }] }] }` (carriers are never sent). `state: 'pipeline'` shows Save again, and its click posts the same rules. As the negative control, the empty reply shows the empty state with no rows.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web` fails, because the module is missing.
- [ ] **Step 3: Implement.** Reuse `ui/Dialog`, `ui/Button`, `ui/States` and `rowAccess.test.tsx`'s mocking pattern.
- [ ] **Step 4: Run it to see it pass.** `npm run test:web && npm run build:web && npm --prefix web run size && npm run lint` are green.
- [ ] **Step 5: Commit.** `git add web/src/features/data` · "Show and edit who sees each column on the dataset's Access tab"

### Task 3: What a viewer outside the list sees
**Files:** Modify `web/src/api/datasets.ts` (`DatasetColumns` column `hidden?: true`; `dataset:page` reply `hidden?: string[]`), `web/src/features/data/DataTab.tsx:110` (it passes the grid only the columns without `hidden`, as `GridColumn.at` source indexes, the hiding `DataGrid` already supports at `DataGrid.tsx:76-80`, and draws a muted note "2 columns hidden" with a `title` naming them), `web/src/features/data/ColumnsTab.tsx` (a hidden column's row shows a `lock` icon and "Hidden from you" in place of its example and value labels), the drill panel `web/src/features/visuals/drill/DrillPanel.tsx` (drops `hidden` columns from its header) · Test `DataTab.test.tsx`, `ColumnsTab` test, `DrillPanel` test
- [ ] **Step 1: Write the failing test.** With a header whose `salary`/`ssn` are `hidden: true`, DataTab's grid has the other columns only. Cell `(0, at=dept)` reads dept's value, never `null` from a neighbour (alignment). The note reads "2 columns hidden". ColumnsTab shows the lock on `salary`. As the negative control, without `hidden` flags (an editor) every column draws and there is no note.
- [ ] **Step 2: Run it to see it fail.** `npm run test:web` fails, because there is no note.
- [ ] **Step 3: Implement** as specified.
- [ ] **Step 4: Run it to see it pass.** `npm run test:web` is green.
- [ ] **Step 5: Commit.** `git add web/src` · "Leave hidden columns out of a viewer's grid and say how many, and lock them in Fields"

### Task 4: The e2e, the operator docs, the changelog
**Files:** Modify `web/e2e/governance.e2e.ts` (03's), `docs/server/row-level-security.md` (a section "Hide a column" after `## Set rules (project admins)` `:36`), `CHANGELOG.md` (Unreleased)
- [ ] **Step 1: Write the test.** As the admin, open Staff → Access and hide `salary` and `ssn` to team HR. The row `bonus_pct · Only: HR (hidden too: computed from salary)` appears. As a viewer outside HR: the grid reads "3 columns hidden", "Pay by department" shows the server's sentence, and "Headcount by department" draws. As an HR viewer, the grid shows `salary`. Take screenshots of the Access tab and the viewer's grid in light and in dark. Clean up by removing the rules. The RPC budget stays ≤ 25.
- [ ] **Step 2: Run it.** `npm run build:web && npm --prefix web run e2e -- governance` passes. Look at all four screenshots.
- [ ] **Step 3: Write the docs.**
  - The operator section: who is restricted (as for rows), what a hidden column hides (values and every figure computed from it, never its name), carriers, the `pipeline` and `gone` states, that publishes, embeds, subscriptions and alerts refuse only when they read a hidden column, and that a page published before the rules stops until republished.
  - A ceiling: a column that a hidden one was computed *from* is not hidden.
  - The release-A note: the rule from `docs/server/upgrade.md`'s p4-01a section.
  - The CHANGELOG lines: certified and retired status, hidden columns, and the share-policy mask fix (06 Task 5).
  - Check `node scripts/test-serverDocs.js` reports `ok`.
- [ ] **Step 4: Commit.** `git add web/e2e/governance.e2e.ts docs/server/row-level-security.md CHANGELOG.md` · "Walk hiding a column through the browser and document it for operators"

After this PR merges, release B can be cut. The owner cuts it.
