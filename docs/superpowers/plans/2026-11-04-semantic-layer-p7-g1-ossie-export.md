# Semantic layer part 7, step g1: Ossie export — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An editor downloads the project's definitions as one Ossie file, pinned to the spec version it was tested against, with a report of everything that did not map; nothing is ever imported from Ossie in this part.
**Architecture:** A pure mapper (`src/app/ossieExport.ts`) reads a1's `exportModel` output, so it inherits a1's whitelist (no origin, rule, secret or row ever reaches it), and writes the Ossie document plus the report. `model:exportOssie` hands it back as a download, as `model:export` does. A spike comes first, because every Ossie name in the spec is **(to verify)**.
**Tech Stack:** `src/app`, `src/ipc`, `src/api`, React (`web/src/features/model`), self-checks.
**Spec:** docs/semantic-layer/07-portability.md (D9 and its table; Non-goals "Ossie import") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p7-00-index.md
**Branch and PR:** `feat/semantic-p7-g1-ossie-export` off `origin/develop` after a4 merges (it uses a4's `modelRefusal` and doc page; it shares `src/api/model.ts` and `ExportMenu.tsx` with f1, so it goes after f1 in the chain). One PR. Stores nothing, so any release.

## Every Ossie name is (to verify)

D9's table names the Ordinate side only. The spec's version, its file format (YAML or JSON), its object names (dataset or logical table, fields or dimensions, synonyms, metric expressions, derived metrics, time dimensions, semi-additive measures, relationships, AI context), whether it has metric filters, named filters, roles and vendor extensions are all unknown here. Task 1 reads the spec as published on the day and records each answer with a link; nothing in Tasks 2–4 is written before that.

## Global Constraints

- **Pinned.** `OSSIE_SPEC_VERSION` is the version Task 1 read, written into the document where the spec says, and checked by the golden. A later spec version is a new PR.
- **Built on a1's export**, never on the stores, so D3's "never" list holds by construction. Never exported: row access rules, sensitivity, secrets, calendar values, formats beyond what the spec has, and Ordinate ids where the spec does not ask for them.
- **Source table names (D9)** only for Live datasets whose connection the caller can open (part 2's rule). Until part 2 names a narrower check, that is `write` on the project, which this export already requires (`connection:*` contracts are `write`, `src/api/connections.ts`). Then the name is `liveSourceOf` (`src/engine/live/liveTarget.ts:64`) of a table origin; a SQL-defined Live dataset and every extract export with no source, and the report says so for each.
- **Mapping:** exactly D9's table, and only where Task 1 found the target: formula metrics only when they are `+ − × ÷` of other metrics (`src/analysis/metricFormula.ts` compiles them; anything else is reported); snapshot metrics only if the spec has semi-additive measures; filters on metrics only if the spec has metric filters; terms only if it has named filters. Everything else is in the report by object and reason: terms, value labels, base filters, formats, direction, calendar, and whatever Task 1 found missing. If the spec allows vendor extensions, the unmapped definitions go under an `ordinate` extension (and the report still lists them as "not in Ossie").
- **Writer.** If the spec's file is YAML, it is written by a small writer for these exact shapes in `src/app/ossieYaml.ts`: every string a double-quoted JSON string (valid YAML), keys from a fixed set, no anchors or tags, sorted as a1 sorts. No YAML library (no dependency). If JSON, a1's `modelJson`.
- **Byte-stable**: unchanged project, same release → identical bytes (a1's rule); the golden `scripts/fixtures/golden/ossie/` is recorded once and never re-recorded.
- **Access**: `model:exportOssie` is `write`, project scope, `restrictedOn` refused (a4's `modelRefusal`).
- **Checked against the spec**: if the spec publishes a JSON Schema, Task 3 checks the fixture's output against the parts it emits with a test-only structural check (required keys, types, enums). A full schema validator would be a dependency: ask the owner first.
- No dependency, no migration, no stored field.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **The report is complete:** every object of the model files appears in the document or in the report, never neither. Task 3.
- **Source names leak nowhere else:** a planted table name appears only in the Live table-origin dataset's Ossie entry; a planted SQL string and a secret appear nowhere. Task 3.

---

### Task 1: Spike: read the Ossie spec (no product code)
**Files:** Create `docs/semantic-layer/ossie-mapping.md`
- [ ] **Step 1:** Find the current published Ossie (Open Semantic Interchange) specification; record its version, date, licence, file format, schema location, and for each row of D9's table the exact target object and keys, with links.
- [ ] **Step 2:** Mark each D9 row mapped, partly mapped (say what is lost) or not mapped; say whether vendor extensions are allowed and how.
- [ ] **Step 3:** If no versioned spec with a defined structure is published, stop here, commit the doc, and tell the owner: the rest of this plan waits.
- [ ] **Step 4: Commit.** `git add docs/semantic-layer/ossie-mapping.md` · "Record how Ordinate's model maps onto the Ossie spec, version pinned"

### Task 2: The mapper and its report
**Files:** Create `src/app/ossieExport.ts` (and `src/app/ossieYaml.ts` if the spec is YAML), `scripts/test-ossieExport.ts` (on a1's `scripts/modelFixture.ts`)
**Interfaces:** Produces `OSSIE_SPEC_VERSION`; `interface OssieReport { notMapped: Array<{ kind: string; name: string; reason: string }>; noSource: string[] }`; `toOssie(files: ModelFiles, sources: ReadonlyMap<string, string>): { text: string; report: OssieReport }` (`sources`: dataset id → source table name, only those the caller may see).
- [ ] **Step 1: Write the failing test.**
```ts
const { files } = await exportModel(P); const out = toOssie(files, await sourcesFor(P));
ok('the version is pinned in the document', out.text.includes(OSSIE_SPEC_VERSION));
ok('every model object is in the document or the report', allObjects(files).every((o) => inDocument(out.text, o) || out.report.notMapped.some((n) => n.name === o.name)));
ok('a formula that is not + − × ÷ of metrics is reported', out.report.notMapped.some((n) => n.name === 'Weighted margin' && n.kind === 'metric'));
ok('terms and value labels are reported (unless Task 1 found a target)', reportedOrMapped(out, 'term', 'EMEA') && reportedOrMapped(out, 'valueLabels', 'region'));
ok('a SQL-defined Live dataset and an extract have no source', out.report.noSource.includes('Sales (SQL)') && out.report.noSource.includes('Orders'));
ok('the table-origin Live dataset names its source', out.text.includes(PLANTED_TABLE));
ok('no planted SQL, secret or rule value', [PLANTED_SQL, PLANTED_SECRET, RULE_VALUE].every((n) => !out.text.includes(n) && !JSON.stringify(out.report).includes(n)));
ok('byte-stable', toOssie(files, await sourcesFor(P)).text === out.text);
```
- [ ] **Step 2–4:** red → implement → `npm run build:ts && node scripts/test-ossieExport.js` green.
- [ ] **Step 5: Commit.** `git add src/app/ossie*.ts scripts/test-ossieExport.ts` · "Map the model onto Ossie, reporting everything that does not map"

### Task 3: The golden and the structural check
**Files:** Create `scripts/fixtures/golden/ossie/` (recorded once), `scripts/ossieShape.ts` (test-only structural check from the spec's schema, if one is published) · Test `scripts/test-ossieExport.ts`
- [ ] **Step 1:** Record the fixture's document and report once, read them by hand against `docs/semantic-layer/ossie-mapping.md`, commit; then `ok('the golden matches', …)` and `ok('the emitted parts satisfy the spec\'s required keys and types', ossieShape(out.text).length === 0)` with a NEGATIVE CONTROL (a document missing a required key fails `ossieShape`).
- [ ] **Step 2: Commit.** `git add scripts/fixtures/golden/ossie scripts/ossieShape.ts scripts/test-ossieExport.ts` · "Pin the Ossie export to a golden and the spec's required shape"

### Task 4: `model:exportOssie` and Export ▾ → Ossie
**Files:** Modify `src/api/model.ts` (append), `src/ipc/modelFiles.ts`, `web/src/features/model/ExportMenu.tsx` (a1), `web/src/features/model/exportMenu.test.tsx`, `docs/server/model-files.md` (a4: an "Ossie" section: the pinned version, what maps, what does not)
**Interfaces:** `'model:exportOssie': rpc({ access: 'write', input: z.strictObject({ projectId: Uuid }), project: byProjectId })` → `{ ok: true; downloadToken: string; report: OssieReport } | { ok: false; error: string }`.
- [ ] **Step 1: Write the failing test.** Server: the route's file equals `toOssie` of the same project; a viewer → 403; a restricted editor → `modelRestricted()`. Web: Export ▾ shows **Ossie**; choosing it downloads and then lists the report ("Not in Ossie: 3 terms, value labels on 2 fields…") in a dialog with a designed empty state ("Everything mapped.").
- [ ] **Step 2–4:** red → implement → `node scripts/test-ossieExport.js && node scripts/check-contracts.js && npm run test:web && npm run build:web && npm run lint` green.
- [ ] **Step 5: Commit.** `git add src/api/model.ts src/ipc/modelFiles.ts web/src/features/model docs/server/model-files.md` · "Add Export ▾ Ossie with its report of what did not map"

**Before the PR:** `npm test`, `npm run test:web`, `npm run lint`.
