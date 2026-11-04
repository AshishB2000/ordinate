# Semantic layer part 7, step a4: model files over MCP, so git can drive them — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CI job holding a personal API token exports the model as files inline and imports committed files inline: a dry run by default, `apply: true` with the plan hash.
**Architecture:** Two MCP tools in the existing registry (`src/automation/registry.ts`), handled in a new `src/automation/modelTools.ts` that calls a1's `exportModel`, a2's `readModelFiles` + `planImport` and a3's `applyImport`: the same code as the RPC channels, through the same access check. One new optional field on `Command` lets a tool that writes nothing still require an editor. `docs/automation.md` is regenerated; a short operator page explains the files and the CI loop.
**Tech Stack:** `src/automation`, docs, self-checks.
**Spec:** docs/semantic-layer/07-portability.md (D7, D8; Non-goals "Git sync") · Index: docs/superpowers/plans/2026-11-04-semantic-layer-p7-00-index.md
**Branch and PR:** `feat/semantic-p7-a4-model-mcp` off `origin/develop` after a3 merges. One PR. Release 1.

## Global Constraints

- **Tools.** `export_model { project? }` → `{ format, formatVersion, files: { [path]: string } }`. `import_model { project?, files, apply?, planHash?, choices? }`: without `apply` it returns `{ plan }` (a2's `ImportPlan`); with `apply: true` it needs `planHash` and returns a3's `{ written, failed }` or the `plan_changed` sentence. No `before` download over MCP: the caller's git history is the undo.
- **Access.** `import_model` is `readOnly: false, writes: 'records'`. `export_model` writes nothing but must need an editor (D7): `Command` gains `needs?: 'editor'`. `src/automation/serverMcp.ts:82` asks `write` when `!c.readOnly || c.needs === 'editor'`, and the audit at `:93` runs for those too. `docs.ts:25,43` prints such a tool as "read (editors)". Both tools refuse `restrictedOn(projectId)` with `modelRestricted()` through the same helper the RPC handlers use (`modelRefusal(projectId)`, moved from `src/ipc/modelFiles.ts` into `src/app/modelAccess.ts`).
- **Size.** Bodies stay within `MAX_BODY` (1 MiB, `src/automation/httpTransport.ts:21`). A model past it is a 413 from the transport; the tool summary and the doc say to use the app's Import for larger models. Inline files go through `readModelFiles`: the same whitelist, caps and value budget as a zip (a2 Task 1).
- `files` arrive as JSON strings, keyed by the D2 path; `export_model`'s files are byte-identical to the zip's entries (a1).
- `node scripts/gen-automation-docs.js` regenerates `docs/automation.md`; `scripts/test-automation.ts` fails if the committed copy differs. `src/automation/registry.ts` is 394 lines: two entries (~30 lines) fit; handlers go in the new file (`handlers.ts` is 336).
- No dependency, no migration, no stored field, no new RPC channel.
- No `Co-Authored-By` or AI trailer on any commit.

## Review Focus

- **A viewer's token cannot export.** `export_model` with a viewer token is denied, and the call is audited. Task 1.
- **Same plan both ways.** `import_model`'s dry run over the files equals `model:importPlan` over the zip of the same files (hash included). Task 1.
- **Apply needs the hash.** `apply: true` without `planHash` is a usage error, never an apply. Task 1.

---

### Task 1: The two tools
**Files:** Create `src/automation/modelTools.ts`, `src/app/modelAccess.ts`, `scripts/test-modelMcp.ts` (harness of `scripts/test-automation.ts`'s server-mode section) · Modify `src/automation/registry.ts` (Command `needs?`, two entries), `src/automation/serverMcp.ts:82,93`, `src/automation/docs.ts:25,43`, `src/ipc/modelFiles.ts` (use `modelAccess`)
**Interfaces:** Produces `exportModelTool(ctx: Ctx): Promise<{ format: string; formatVersion: number; files: Record<string, string> }>`, `importModelTool(ctx: Ctx, args: { files: unknown; apply?: unknown; planHash?: unknown; choices?: unknown }): Promise<unknown>`, `modelRefusal(projectId: string): Promise<string | null>`. Registry entries: `{ tool: 'export_model', readOnly: true, needs: 'editor', summary: 'The project\'s definitions as model files (JSON and a markdown guide per dataset), inline. Commit them to git.', args: { project: PROJECT } }` and `{ tool: 'import_model', readOnly: false, writes: 'records', summary: 'Import model files: a dry run unless apply is true with the dry run\'s planHash. Never deletes. Over 1 MiB, use the app.', args: { project, files: { type: 'object', … }, apply: { type: 'boolean' }, planHash: { type: 'string' }, choices: { type: 'object', … } }, required: ['files'] }`.
- [ ] **Step 1: Write the failing test.**
```ts
const ex = await mcp(EDITOR_TOKEN, 'export_model', { project: P });
ok('export_model returns the same files as model:export\'s zip', stableStringify(ex.files) === stableStringify(Object.fromEntries((await exportModel(P)).files)));
ok('a viewer\'s token is denied export_model, and the call is audited', (await mcp(VIEWER_TOKEN, 'export_model', { project: P })).denied === true && (await auditRows('mcp:export_model')).some((r) => r.outcome === 'denied'));
ok('a restricted editor\'s token gets modelRestricted()', (await mcp(RESTRICTED_TOKEN, 'export_model', { project: P })).error === modelRestricted());
const dry = await mcp(EDITOR_TOKEN, 'import_model', { project: P, files: edited(ex.files) });
ok('dry run by default: a plan, nothing written', typeof dry.plan.hash === 'string' && writes() === w0);
ok('the same plan as model:importPlan over the zip of the same files', dry.plan.hash === (await planViaRpc(P, zipOf(edited(ex.files)))).plan.hash);
ok('apply without planHash is a usage error, not an apply', (await mcp(EDITOR_TOKEN, 'import_model', { project: P, files: edited(ex.files), apply: true })).code === 'usage' && writes() === w0);
const done = await mcp(EDITOR_TOKEN, 'import_model', { project: P, files: edited(ex.files), apply: true, planHash: dry.plan.hash });
ok('apply with the hash writes the change', done.written.length === 1);
ok('an unknown file name refuses the whole import', 'error' in (await mcp(EDITOR_TOKEN, 'import_model', { project: P, files: { ...ex.files, 'x.txt': 'y' } })));
```
- [ ] **Step 2: Run it to see it fail.** `npm run build:ts && node scripts/test-modelMcp.js` → unknown tool `export_model`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run it to see it pass.** `node scripts/test-modelMcp.js && node scripts/test-automation.js` (after Task 2's regeneration) → all `ok`.
- [ ] **Step 5: Commit.** `git add src/automation src/app/modelAccess.ts src/ipc/modelFiles.ts scripts/test-modelMcp.ts` · "Add export_model and import_model to MCP, as an editor, dry run first"

### Task 2: The docs
**Files:** Modify `docs/automation.md` (regenerated), `docs/README.md` (one index line) · Create `docs/server/model-files.md`
- [ ] **Step 1:** `npm run build:ts && node scripts/gen-automation-docs.js`; `node scripts/test-automation.js` → `ok`.
- [ ] **Step 2:** Write `docs/server/model-files.md`: the layout (D2) with one real file of each kind from the golden fixture; what travels and what never does (D3); the merge rules a dry run applies (D4: id then name, three-way only within one project, never a delete, sensitivity never lowered); byte-identity within one release; the CI loop: a job runs `export_model`, commits the files, and another job runs `import_model` (dry run on a pull request, `apply: true` with the hash on merge), with a JSON-RPC request body for each through `POST /api/mcp`; the 1 MiB inline limit.
- [ ] **Step 3:** `node scripts/test-serverDocs.js` → `ok` (no new env var).
- [ ] **Step 4: Commit.** `git add docs/automation.md docs/README.md docs/server/model-files.md` · "Document model files and the git loop over MCP"

**Before the PR:** `npm test`, `npm run lint`, `node scripts/check-contracts.js`.
