// Glossary terms (semantic D10–D12): the record and its contracts — real modules, the real RPC route
// in server mode (dev sign-in) over a temp DATA_DIR.
//
//   § record      saved with sanitized aliases; a name or alias a metric or another term holds is
//                 taken (and a metric may not take a term's); a term inside a term, a column the dataset
//                 lacks and no filter at all are refused with the box they belong to; sanitizing is
//                 idempotent; a stale base refuses the update (409 record_changed); Trash round-trips;
//                 the bundle carries `terms/` and a term's history
//   § contracts   term:list / get / save / update / delete over HTTP; a version is recorded and restored
// What a row-restricted viewer reads of a term is pinned in scripts/test-rowPolicySafetyNet.ts (its world).
//
//   npm run build:ts && node scripts/test-terms.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-terms-'));

const context: typeof import('../src/server/context') = require('../src/server/context');
const appMod: typeof import('../src/server/app') = require('../src/server/app');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');
const terms: typeof import('../src/analysis/terms') = require('../src/analysis/terms');
const termNames: typeof import('../src/analysis/termNames') = require('../src/analysis/termNames');
const msg: typeof import('../src/data/termMessages') = require('../src/data/termMessages');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const editConflict: typeof import('../src/app/editConflict') = require('../src/app/editConflict');
const bundleRules: typeof import('../src/app/bundleRules') = require('../src/app/bundleRules');

type Identity = import('../src/server/context').Identity;
const ADMIN: Identity = { user: { email: 'ana@acme.test', role: 'admin' }, org: { id: 'acme' } };
const COLUMNS = [{ name: 'region', type: 'text' as const }, { name: 'sales', type: 'number' as const }];
const ROWS = [['EU', 10], ['ME', 20], ['US', 5], ['AF', 1]];
const EMEA_F = { type: 'filter', column: 'region', op: 'in', values: ['EU', 'ME', 'AF'] };

const caught = async (f: () => Promise<unknown>): Promise<unknown> => f().then(() => null, (e: unknown) => e);

(async () => {
  context.enterServerMode(DATA);
  appMod.registerHandlers();
  const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA }), undefined, () => ADMIN);
  type Reply = { status: number; text: string; body: any }; // any: each channel's own reply
  const call = async (channel: string, payload: unknown): Promise<Reply> => {
    const r = await app.inject({
      method: 'POST', url: `/api/rpc/${encodeURIComponent(channel)}`,
      headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [payload] }),
    });
    let body: unknown = null;
    try { body = r.statusCode === 200 ? wire.decode(r.body) : JSON.parse(r.body); } catch { body = null; }
    return { status: r.statusCode, text: r.body, body };
  };
  const as = <T>(fn: () => Promise<T>): Promise<T> => context.runInContext(ADMIN, 'terms', fn);
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');

  const { P, CUST } = await as(async () => {
    await projects.init();
    const P = (await projects.createProject('Terms')).id;
    const d = await datasets.saveDataset(P, { name: 'Customers', sourceKind: 'csv', columns: COLUMNS, rows: ROWS });
    if (!d) throw new Error('fixture not saved');
    return { P, CUST: d.id };
  });
  const M = { datasetId: CUST, definition: { column: 'sales', aggregation: 'sum' } };
  ok('fixture: the metric Revenue', (await call('metric:save', { projectId: P, input: { ...M, name: 'Revenue' } })).body?.ok === true);
  const IN = { name: 'Other', datasetId: CUST, filters: [EMEA_F] };

  // ── § record ──────────────────────────────────────────────────────────────
  const t = await as(() => terms.saveTerm(P, { name: 'EMEA', aliases: ['Europe, Middle East'], datasetId: CUST, filters: [EMEA_F] }));
  ok('saved with sanitized aliases', !!t && t.aliases.join('|') === 'Europe|Middle East' && t.schemaVersion === 1 && t.filters.length === 1, JSON.stringify(t));
  if (!t) throw new Error('no term');
  await as(async () => {
    ok('a metric name is taken', (await termNames.termNameProblem(P, 'revenue', [], undefined)) === msg.termNameTaken('revenue', 'Revenue'));
    ok('an alias another term holds is taken (case- and punctuation-blind)', (await termNames.termNameProblem(P, 'Europe area', ['europe!'])) === msg.termNameTaken('europe!', 'EMEA'));
    ok('NEGATIVE CONTROL: a free name, and the term\'s own names when it is the one renamed', (await termNames.termNameProblem(P, 'APAC', ['Asia'])) === null
      && (await termNames.termNameProblem(P, 'EMEA', ['Europe'], t.id)) === null);
    const problem = (input: object, except?: string) => terms.termProblem(P, input as never, except);
    ok('a term inside a term is refused', (await problem({ ...IN, filters: [{ type: 'term', term: t.id }] }))?.error === msg.termInTerm());
    const gone = await problem({ ...IN, filters: [{ type: 'filter', column: 'nope', op: 'not_empty' }] });
    ok('a column the dataset lacks is refused, beside the filters', gone?.field === 'filters' && gone.error === msg.termColumnMissing('nope', 'Customers'), JSON.stringify(gone));
    ok('no filter is refused', (await problem({ ...IN, filters: [] }))?.error === msg.termNoFilters());
    ok('a dataset that does not exist is refused', (await problem({ ...IN, datasetId: '00000000-0000-4000-8000-000000000000' }))?.field === 'datasetId');
    ok('a taken alias is refused beside the aliases', (await problem({ ...IN, aliases: ['Revenue'] }))?.field === 'aliases');
    ok('NEGATIVE CONTROL: a good input has no problem', (await problem(IN)) === null);
    ok('sanitizing twice is sanitizing once; a mark and a term never stay in a term\'s filters',
      JSON.stringify(terms.sanitizeTermFilters(terms.sanitizeTermFilters([{ ...EMEA_F, fromControl: true }, { type: 'term', term: t.id }]))) === JSON.stringify([EMEA_F]));
    const stale = await caught(() => terms.updateTerm(P, t.id, { name: 'X' }, 'stale'));
    ok('a stale base refuses the update (409 record_changed)', editConflict.isRecordChanged(stale), String(stale));
    const read = await terms.readTerm(P, t.id);
    const moved = await terms.updateTerm(P, t.id, { description: 'Europe, the Middle East and Africa' }, read?.tag);
    ok('NEGATIVE CONTROL: the open tag saves', moved?.description === 'Europe, the Middle East and Africa' && moved.name === 'EMEA');
    const del = await trash.trashRecord(P, 'term', t.id);
    const listed = (await trash.list(P)).some((e) => e.type === 'term' && e.id === t.id && e.name === 'EMEA');
    const goneNow = (await terms.getTerm(P, t.id)) === null && !(await terms.listTerms(P)).some((x) => x.id === t.id);
    const back = await trash.restore(P, 'term', t.id);
    ok('Trash: delete → listed → restore → readable', del.ok && listed && goneNow && back.ok && (await terms.getTerm(P, t.id))?.name === 'EMEA', JSON.stringify({ del, listed, goneNow, back }));
  });
  ok('metric:save refuses a term\'s name or alias, beside the name', await (async () => {
    const r = await call('metric:save', { projectId: P, input: { ...M, name: 'emea' } });
    const r2 = await call('metric:save', { projectId: P, input: { ...M, name: 'Middle-East' } });
    return r.body?.ok === false && r.body.field === 'name' && r.body.error === msg.termNameTaken('emea', 'EMEA') && r2.body?.ok === false;
  })());
  ok('the bundle carries terms and their history', bundleRules.ruleFor(`terms/${t.id}.json`)?.count === 'terms'
    && bundleRules.ruleFor(`history/term/${t.id}/2026-11-04T10-00-00-000Z.json`)?.count === 'versions');
  ok('NEGATIVE CONTROL: a term file outside its folder is not carried', bundleRules.ruleFor(`term/${t.id}.json`) === undefined);

  // ── § contracts ───────────────────────────────────────────────────────────
  const saved = await call('term:save', { projectId: P, input: { name: 'Big markets', aliases: ['Majors'], datasetId: CUST, filters: [{ type: 'filter', column: 'region', op: 'in', values: ['EU', 'US'] }] } });
  ok('term:save answers the term', saved.body?.ok === true && saved.body.term?.name === 'Big markets', saved.text.slice(0, 300));
  const T: string = saved.body?.term?.id ?? '';
  const refused = await call('term:save', { projectId: P, input: { name: 'revenue', datasetId: CUST, filters: [EMEA_F] } });
  ok('term:save refuses a taken name with the sentence, beside the name', refused.body?.ok === false && refused.body.field === 'name' && refused.body.error === msg.termNameTaken('revenue', 'Revenue'), refused.text);
  const inTerm = await call('term:save', { projectId: P, input: { name: 'Nested', datasetId: CUST, filters: [{ type: 'term', term: T }] } });
  ok('term:save refuses a term inside a term', inTerm.body?.ok === false && inTerm.body.field === 'filters' && inTerm.body.error === msg.termInTerm(), inTerm.text);
  const list = await call('term:list', { projectId: P });
  const row = (list.body?.terms ?? []).find((x: { id: string }) => x.id === T);
  ok('term:list: the summary, its dataset and its definition in words, by name', list.body?.ok === true && row?.definition === 'region in EU, US' && row.datasetName === 'Customers'
    && list.body.terms.map((x: { name: string }) => x.name).join('|') === 'Big markets|EMEA', list.text.slice(0, 400));
  const got = await call('term:get', { projectId: P, id: T });
  ok('term:get: the term and its tag', got.body?.ok === true && got.body.term.id === T && typeof got.body.tag === 'string' && got.body.term.valuesHidden === undefined, got.text.slice(0, 300));
  const up = await call('term:update', { projectId: P, id: T, base: got.body?.tag, patch: { filters: [{ type: 'filter', column: 'region', op: 'in', values: ['EU'] }] } });
  ok('term:update with the open tag lands, and says the next tag', up.body?.ok === true && up.body.term.filters[0].values.join() === 'EU' && typeof up.body.tag === 'string' && up.body.tag !== got.body.tag, up.text.slice(0, 300));
  const stale = await call('term:update', { projectId: P, id: T, base: got.body?.tag, patch: { name: 'Stale' } });
  ok('term:update from a stale tag is 409 record_changed', stale.status === 409 && stale.body?.code === 'record_changed', stale.text.slice(0, 200));
  const badCol = await call('term:update', { projectId: P, id: T, patch: { filters: [{ type: 'filter', column: 'nope', op: 'not_empty' }] } });
  ok('term:update checks the columns against the term\'s own dataset', badCol.body?.ok === false && badCol.body.field === 'filters', badCol.text.slice(0, 200));
  const hist = await call('versions:list', { projectId: P, type: 'term', id: T });
  const keys: string[] = Array.isArray(hist.body) ? hist.body.map((v: { key: string }) => v.key) : [];
  ok('a save and an update are two versions, worded', keys.length === 2 && hist.body[0].summary === 'Changed 1 filter', hist.text.slice(0, 300));
  const K0 = keys[keys.length - 1];
  const restore = await call('versions:restore', { projectId: P, type: 'term', id: T, key: K0 });
  const after = await as(() => terms.getTerm(P, T));
  ok('restore of a term version is a save', restore.body?.ok === true && after?.filters[0].values?.join() === 'EU,US', restore.text.slice(0, 300));
  const vdiff = await call('versions:diff', { projectId: P, type: 'term', id: T, from: keys[1], to: keys[0] });
  ok('versions:diff words a term\'s change', vdiff.body?.ok === true && vdiff.body.changes.some((c: { group: string }) => c.group === 'filters'), vdiff.text.slice(0, 300));
  const del = await call('term:delete', { projectId: P, id: T });
  const inTrash = (await call('trash:list', { projectId: P })).body;
  ok('term:delete moves it to the Trash', del.body?.ok === true && Array.isArray(inTrash) && inTrash.some((e: { type: string; id: string }) => e.type === 'term' && e.id === T), JSON.stringify(inTrash).slice(0, 200));
  ok('term:get of a deleted term says so', (await call('term:get', { projectId: P, id: T })).body?.ok === false);

  await app.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
