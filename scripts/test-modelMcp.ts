// The model files over MCP (semantic layer part 7, a4; docs/semantic-layer/07-portability.md D7, D8): `export_model` and
// `import_model` through the registry's own dispatch, over a1's export, a2's reader and planner and a3's apply.
//
//   1. export_model: the same files as model:export's zip, inline; a caller the row access rules restrict is refused
//      with the sentence. NEGATIVE CONTROL: an unrestricted caller gets them.
//   2. import_model: a dry run by default (a plan, nothing written), the same plan hash as model:importPlan over the zip
//      of the same files; apply needs the hash (a usage error otherwise, nothing written); a stale hash writes nothing;
//      the right hash writes the change, with no download offered (git is the undo).
//   3. Untrusted input: an unknown file name, a non-string file and a restricted caller refuse the whole import.
//   4. The registry: export_model needs an editor though it writes nothing; import_model writes records.
//
// The viewer-token denial, its audit row and the real HTTP door are in ./test-modelMcp-db.ts.
//
//   npm run build:ts && node scripts/test-modelMcp.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { H, close, post, upload } from './liveRouteHarness';
import { buildModelFixture } from './modelFixture';
import type { Identity } from '../src/server/context';

const registry: typeof import('../src/automation/registry') = require('../src/automation/registry');
const { exportModel }: typeof import('../src/app/modelExport') = require('../src/app/modelExport');
const { modelJson, MODEL_ZIP_TIME }: typeof import('../src/app/modelFormat') = require('../src/app/modelFormat');
const { writeZipAsync }: typeof import('../src/app/bundle') = require('../src/app/bundle');
const msg: typeof import('../src/app/modelFileMessages') = require('../src/app/modelFileMessages');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const { stableStringify }: typeof import('../src/engine/queryCache') = require('../src/engine/queryCache');
const VIEWER: Identity = { user: { email: 'vic@acme.test', role: 'viewer' }, org: { id: 'acme' } };

type Json = Record<string, any>; // any: a tool's JSON reply, read field by field

// Every record write in the process, counted where all of them go through.
let writeCount = 0;
for (const k of ['writeFile', 'rename'] as const) {
  const real = recordFs[k] as (...a: unknown[]) => Promise<void>;
  (recordFs as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => {
    writeCount++;
    return real(...a);
  };
}

/** One tools/call through the registry, as an editor's token reaches it (access was decided by the server). */
async function mcp(who: Identity, tool: string, args: Record<string, unknown>): Promise<Json> {
  const cmd = registry.findTool(tool);
  if (!cmd) return { error: `unknown tool ${tool}` };
  try {
    return (await H.as(who, () => registry.dispatch(cmd, args, { transport: 'http', headless: true, scope: { canRead: () => true, allow: async () => true } }))) as Json;
  } catch (e) {
    return { error: (e as Error).message, code: (e as { code?: string }).code };
  }
}

(async () => {
  const F = await buildModelFixture();
  const P = F.P;
  const EDITOR = H.ORG_A;
  const exp = await H.as(EDITOR, () => exportModel(P));
  const files = Object.fromEntries(exp.files);
  const edited = (): Record<string, string> => {
    const p = [...exp.files.keys()].find((k) => k.startsWith('datasets/') && k.endsWith('.json') && JSON.parse(exp.files.get(k) as string).id === F.orders) as string;
    return { ...files, [p]: modelJson({ ...JSON.parse(files[p]), description: 'Changed over MCP' }) };
  };

  // ── 1. export_model ──────────────────────────────────────────────────
  const ex = await mcp(EDITOR, 'export_model', { project: P });
  ok('export_model returns the same files as model:export\'s, inline', stableStringify(ex.files) === stableStringify(files), Object.keys(ex.files ?? {}));
  ok('…with the format and its version', ex.format === 'ordinate-model' && ex.formatVersion === 1, [ex.format, ex.formatVersion]);
  const asViewer = await mcp(VIEWER, 'export_model', { project: P });
  ok('a restricted caller is refused with the sentence, and gets no files', asViewer.error === msg.modelRestricted() && !('files' in asViewer), JSON.stringify(asViewer).slice(0, 300));

  // ── 2. import_model: dry run, hash, apply ────────────────────────────
  const w0 = writeCount;
  const dry = await mcp(EDITOR, 'import_model', { project: P, files: edited() });
  ok('dry run by default: a plan, and nothing written', typeof dry.plan?.hash === 'string' && dry.plan.items.some((i: Json) => i.status === 'updated') && writeCount === w0, JSON.stringify(dry).slice(0, 300));
  const zip = await writeZipAsync(Object.keys(edited()).sort().map((name) => ({ name, data: Buffer.from(edited()[name], 'utf8') })), MODEL_ZIP_TIME);
  const viaRpc = await post('model:importPlan', { projectId: P, fileToken: (await upload(zip, 'model.zip')).fileToken });
  ok('the same plan, hash included, as model:importPlan over the zip of the same files', viaRpc.value.plan?.hash === dry.plan.hash && stableStringify(viaRpc.value.plan) === stableStringify(dry.plan));
  const w1 = writeCount;
  const noHash = await mcp(EDITOR, 'import_model', { project: P, files: edited(), apply: true });
  ok('apply without planHash is a usage error, and nothing is written', noHash.code === 'usage' && !('written' in noHash) && writeCount === w1, JSON.stringify(noHash));
  const stale = await mcp(EDITOR, 'import_model', { project: P, files: edited(), apply: true, planHash: 'not-the-hash' });
  ok('a hash that is not the dry run\'s writes nothing and says so', stale.error === msg.modelPlanChanged() && writeCount === w1, JSON.stringify(stale));
  const done = await mcp(EDITOR, 'import_model', { project: P, files: edited(), apply: true, planHash: dry.plan.hash });
  ok('apply with the hash writes the change', done.written?.length === 1 && done.failed?.length === 0, JSON.stringify(done));
  ok('…and offers no download: git is the undo', !('before' in done));
  const after = await H.as(EDITOR, () => exportModel(P));
  ok('…and the export now shows it', [...after.files.values()].some((t) => t.includes('Changed over MCP')));
  const again = await mcp(EDITOR, 'import_model', { project: P, files: edited() });
  ok('re-planning the applied files: nothing left to write', again.plan.items.every((i: Json) => i.status === 'unchanged'), JSON.stringify(again.plan.items.map((i: Json) => i.status)));

  // ── 3. Untrusted input ───────────────────────────────────────────────
  const w2 = writeCount;
  ok('an unknown file name refuses the whole import', (await mcp(EDITOR, 'import_model', { project: P, files: { ...files, 'x.txt': 'y' } })).error === msg.modelEntryRefused('x.txt'));
  ok('a file that is not text is a usage error', (await mcp(EDITOR, 'import_model', { project: P, files: { ...files, 'model.json': 7 } })).code === 'usage');
  ok('files that are not a model are refused in a sentence', (await mcp(EDITOR, 'import_model', { project: P, files: { 'model.json': '{' } })).error === msg.modelNotAModel());
  const rv = await mcp(VIEWER, 'import_model', { project: P, files: edited() });
  ok('a restricted caller is refused with the sentence', rv.error === msg.modelRestricted());
  ok('NEGATIVE CONTROL: the same files from an unrestricted caller plan', typeof (await mcp(EDITOR, 'import_model', { project: P, files: edited() })).plan?.hash === 'string');
  ok('none of those wrote anything', writeCount === w2);

  // ── 4. The registry ──────────────────────────────────────────────────
  const e = registry.findTool('export_model');
  const i = registry.findTool('import_model');
  ok('export_model writes nothing but needs an editor; import_model writes records', e?.readOnly === true && e.needs === 'editor' && i?.readOnly === false && i.writes === 'records');
  ok('NEGATIVE CONTROL: the read tools do not ask for an editor', registry.COMMANDS.filter((c) => c.tool !== 'export_model' && c.readOnly).every((c) => c.needs === undefined));

  await close();
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
