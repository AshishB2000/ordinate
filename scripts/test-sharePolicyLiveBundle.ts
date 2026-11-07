// A Live dataset's base filters (semantic layer part 1, PR 08) in a project bundle the Share policy shapes
// (src/app/sharePolicy.ts `applyToBundle`): a base filter on a column marked personal or financial leaves
// without its values, as the column's sample values and value labels do (masked in Prepare or not, under mask
// and drop alike); the step's column and operator stay, and so does every step on an unmarked column. A
// calculated field (part 8 04) whose formula reads the marked column leaves with its name and type and no
// formula, which the other side reads as unreadable and refuses; a calc over an unmarked column travels. The
// bundle is the one `projects:export` offers for download, inflated and grepped entry by entry.
//
//   npm run build:ts && node scripts/test-sharePolicyLiveBundle.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { randomUUID }: typeof import('crypto') = require('crypto');

process.env.ORDINATE_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-livebase-'));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-share-livebase-out-'));

const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const store: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
const bundle: typeof import('../src/app/bundle') = require('../src/app/bundle');
const liveRecord: typeof import('../src/data/liveRecord') = require('../src/data/liveRecord');
const liveDataset: typeof import('../src/data/liveDataset') = require('../src/data/liveDataset');
const liveBase: typeof import('../src/engine/live/liveBase') = require('../src/engine/live/liveBase');
const liveCalcs: typeof import('../src/data/liveCalcs') = require('../src/data/liveCalcs');
const files: typeof import('../src/server/files') = require('../src/server/files');
const handlers: Map<string, (e: unknown, arg: unknown) => Promise<any>> = require('../src/server/rpc').handlers; // any: each reply is narrowed by its check
require('../src/ipc/projects').register({});

const show = (v: unknown): string => JSON.stringify(v);
const EMAIL = 'a@b.c';
const LISTED = 'x@y.z';
const ANA = 'ana-canary@acme.test';
const CALCS = [
  { name: 'IsAna', expression: `IF [email] = '${ANA}' THEN 1 ELSE 0 END`, type: 'number' },
  { name: 'Double', expression: '[amount] * 2', type: 'number' },
] as const;
const BASE = [
  { type: 'filter', column: 'email', op: '=', value: EMAIL },
  { type: 'filter', column: 'region', op: 'in', values: ['North', 'West'] },
  { type: 'filter', column: 'email', op: 'in', values: [LISTED] },
] as const;

async function main(): Promise<void> {
  await projects.init();
  const P = (await projects.createProject('Live base share')).id;
  const live = await liveRecord.saveLiveRecord(P, { name: 'Contacts', origin: { kind: 'connection', connId: randomUUID(), table: 'contacts' },
    columns: [{ name: 'email', type: 'text' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' }] });
  const L = live!.id;
  ok('fixture: the base filters are stored', !!(await liveDataset.setBaseFilters(P, L, BASE.map((s) => ({ ...s })) as any)) // any: the steps as stored
    && show((await datasets.getDatasetMeta(P, L))!.live!.baseFilters) === show(BASE));
  ok('fixture: the calcs are stored', !!(await liveDataset.setLiveCalcs(P, L, CALCS.map((c) => ({ ...c })))));
  await catalog.setColumn(P, L, 'email', { sensitivity: 'personal' });

  const exported = async (action: 'mask' | 'drop' | 'include'): Promise<{ bytes: Buffer; entries: { name: string; data: Buffer }[]; rec: any }> => { // any: the record as exported
    await store.setPolicy(P, { bundle: action });
    const r = await handlers.get('projects:export')!(null, { id: P });
    const file = r && r.downloadToken ? files.downloadPathForTest(r.downloadToken) : null;
    if (!file) throw new Error('no bundle: ' + show(r));
    const bytes = fs.readFileSync(file);
    fs.copyFileSync(file, path.join(outDir, action + '.ordinate'));
    const entries = bundle.readZip(bytes);
    return { bytes, entries, rec: JSON.parse(entries.find((e) => e.name === `datasets/${L}.json`)!.data.toString('utf8')) };
  };
  const carrying = (entries: { name: string; data: Buffer }[], v: string): string[] => entries.filter((e) => e.data.includes(v)).map((e) => e.name);

  const raw = bundle.readZip((await bundle.exportProject(P))!.bytes);
  ok('NEGATIVE CONTROL: an unshaped export carries both values in the dataset record, so the grep below can see them',
    show(carrying(raw, EMAIL)) === show([`datasets/${L}.json`]) && show(carrying(raw, LISTED)) === show([`datasets/${L}.json`]), show([carrying(raw, EMAIL), carrying(raw, LISTED)]));
  ok('NEGATIVE CONTROL: an unshaped export carries the calc\'s literal in the dataset record', show(carrying(raw, ANA)) === show([`datasets/${L}.json`]), show(carrying(raw, ANA)));

  for (const action of ['mask', 'drop'] as const) {
    const { entries, rec } = await exported(action);
    ok(`${action}: no entry of the bundle carries a base-filter value of the marked column`, carrying(entries, EMAIL).length === 0 && carrying(entries, LISTED).length === 0,
      show([carrying(entries, EMAIL), carrying(entries, LISTED)]));
    ok(`${action}: the marked column's steps keep their column and operator; the unmarked region's keeps its values`, show(rec.baseFilters) === show([
      { type: 'filter', column: 'email', op: '=' }, BASE[1], { type: 'filter', column: 'email', op: 'in' },
    ]), show(rec.baseFilters));
    ok(`${action}: the mark travels`, JSON.parse(entries.find((e) => e.name === 'catalog.json')!.data.toString('utf8')).columns[L].email.sensitivity === 'personal');
    ok(`${action}: no entry carries the literal of a calc over the marked column`, carrying(entries, ANA).length === 0, show(carrying(entries, ANA)));
    ok(`${action}: that calc keeps its name and type, no formula; NEGATIVE CONTROL: the calc over the unmarked amount travels as is`,
      show(rec.calculated) === show([{ ...CALCS[0], expression: '' }, CALCS[1]]), show(rec.calculated));
    const imported = await bundle.importBundle(fs.readFileSync(path.join(outDir, action + '.ordinate')));
    const back = imported.ok && imported.project ? (await datasets.listDatasets(imported.project.id))[0] : null;
    const backBase = back ? (await datasets.getDatasetMeta(imported.project!.id, back.id))?.live?.baseFilters : null;
    ok(`${action}: the shaped bundle still imports, its Live dataset keeping the steps as they travelled`, show(backBase) === show(rec.baseFilters), show([imported, backBase]));
    const backLive = back ? (await datasets.getDatasetMeta(imported.project!.id, back.id))?.live : undefined;
    ok(`${action}: the imported Live dataset reads its calcs as unreadable, so it refuses (hasLiveCalcs)`,
      backLive?.calculatedUnreadable === true && show(backLive.calculated) === show([CALCS[1]]) && liveCalcs.hasLiveCalcs(backLive), show(backLive));
    // A step that travelled without its value must refuse like a value-less `in`, never compare against blank.
    const cols = [{ name: 'email', type: 'text' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' }] as any; // any: LiveColumn rows
    const refusal = (s: unknown): string => show(liveBase.liveBaseOf([s as any], cols)); // any: a stored step
    const inRefusal = refusal({ type: 'filter', column: 'email', op: 'in' });
    ok(`${action}: the value-less \`in\` step refuses`, inRefusal.includes('"baseFilter"'), inRefusal);
    for (const op of ['=', '!=', '>', '<', '>=', '<=', 'contains']) {
      ok(`${action}: a value-less \`${op}\` step refuses as \`in\` does, never compared to blank`, refusal({ type: 'filter', column: 'email', op }) === inRefusal, refusal({ type: 'filter', column: 'email', op }));
    }
    ok(`${action}: the imported Live dataset's own shaped list refuses`, !!backBase && (liveBase.liveBaseOf(backBase as any, cols) as { ok: boolean }).ok === false, show(backBase)); // any: stored steps
    ok(`${action}: NEGATIVE CONTROL: a step with its value, and a value-less \`is_empty\`, still compile`,
      (liveBase.liveBaseOf([BASE[0]] as any, cols) as { ok: boolean }).ok === true && (liveBase.liveBaseOf([{ type: 'filter', column: 'email', op: 'is_empty' }] as any, cols) as { ok: boolean }).ok === true); // any: stored steps
  }
  const twice = { baseFilters: BASE.map((st) => ({ ...st })) };
  const base: typeof import('../src/data/liveBaseFilters') = require('../src/data/liveBaseFilters');
  const first = base.withoutBaseValues(twice, new Set(['email']));
  const after = show(twice.baseFilters);
  ok('withoutBaseValues twice is once, and an unmarked step is never touched',
    first && !base.withoutBaseValues(twice, new Set(['email'])) && show(twice.baseFilters) === after && show(twice.baseFilters[1]) === show(BASE[1]), after);
  const incl = await exported('include');
  ok('NEGATIVE CONTROL: under include the values travel as they are', show(incl.rec.baseFilters) === show(BASE) && carrying(incl.entries, EMAIL).length === 1);
  ok('NEGATIVE CONTROL: under include the calcs travel as they are', show(incl.rec.calculated) === show(CALCS), show(incl.rec.calculated));
  ok('the dataset itself keeps its base filters (the export shapes a copy)', show((await datasets.getDatasetMeta(P, L))!.live!.baseFilters) === show(BASE));
}

main().then(finish, (err) => {
  console.error(err);
  process.exitCode = 1;
  finish();
});
