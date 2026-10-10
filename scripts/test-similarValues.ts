// Prepare's "Find similar values" (src/data/valueClusters.ts, the
// prepare:similarValues channel in src/ipc/preparePower.ts).
//
//   key        case, accents, punctuation, company suffixes and word order do
//              not tell two values apart; NEGATIVE CONTROLS: different names,
//              and a suffix that is the whole value, do
//   cluster    the most frequent value wins (then the shortest); `rows` is the
//              rows the merge rewrites; a group from the Assistant joins
//              clusters a key cannot (US / United States)
//   check      a model's reply is held to the column's own values: an invented
//              string, a non-string and a repeat are dropped, a group left with
//              one value is no group
//   apply      DIFFERENTIAL: the suggested rules, run as an ordinary
//              replace_values step by the pipeline, rewrite exactly `rows`
//              cells and leave one value per cluster
//   input      the scan reads the step's real INPUT — after the steps before it
//   refuse     a number column, a column the table does not have
//   assistant  no model configured → the clusters still come back, with why
//
//   npm run build:ts && node scripts/test-similarValues.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-similar-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const vc: typeof import('../src/data/valueClusters') = require('../src/data/valueClusters');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const prepare: typeof import('../src/ipc/preparePower') = require('../src/ipc/preparePower');

type Any = any; // any: the channel's reply, read field by field below
const show = (v: unknown): string => JSON.stringify(v).slice(0, 500);
const same = (...vs: string[]): boolean => new Set(vs.map(vc.valueKey)).size === 1;

// ── key ───────────────────────────────────────────────────────────────────
ok('key: case, spacing and punctuation', same('Google', 'google', ' GOOGLE ', 'Google.', 'Google,'));
ok('key: company suffixes', same('Google', 'Google LLC', 'google inc', 'Google, Inc.', 'The Google Company'));
ok('key: dotted abbreviations and apostrophes', same('USA', 'U.S.A.', 'u.s.a') && same("O'Brien", 'OBrien', 'O’Brien'));
ok('key: accents and word order', same('Société Générale', 'societe generale', 'Generale, Societe'));
ok('NEGATIVE CONTROL: different names keep different keys', !same('Google', 'Alphabet') && !same('US', 'United States') && !same('North', 'North West'));
ok('NEGATIVE CONTROL: a suffix that is the whole value is kept', vc.valueKey('Co') === 'co' && vc.valueKey('The') === 'the' && !same('Inc', 'LLC'));
ok('key: nothing to compare → no key', vc.valueKey('—') === '' && vc.valueKey('  ') === '' && vc.valueKey('?!') === '');

// ── cluster ───────────────────────────────────────────────────────────────
const COUNTS: Array<[string, number]> = [
  ['Google', 40], ['Google LLC', 12], ['google inc', 3], ['Alphabet/Google', 2],
  ['US', 5], ['USA', 30], ['U.S.A.', 4], ['United States', 9],
  ['Acme', 7], ['—', 1], ['?', 1],
];
const plain = vc.clusterValues(COUNTS);
ok('cluster: the most frequent value is what the others become', show(plain) === show([
  { to: 'Google', toCount: 40, from: [{ value: 'Google LLC', count: 12 }, { value: 'google inc', count: 3 }], rows: 15 },
  { to: 'USA', toCount: 30, from: [{ value: 'U.S.A.', count: 4 }], rows: 4 },
]), show(plain));
ok('cluster: values with no key never cluster together', !plain.some((c) => c.to === '—' || c.to === '?'));
ok('cluster: a tie goes to the shorter value', vc.clusterValues([['Google LLC', 5], ['Google', 5]])[0].to === 'Google');
const helped = vc.clusterValues(COUNTS, [['US', 'USA', 'United States'], ['Google', 'Alphabet/Google'], ['Acme', 'Not in the column']]);
ok('cluster: an Assistant group joins what a key cannot see', show(helped.map((c) => [c.to, c.from.map((m) => m.value), c.rows])) === show([
  ['USA', ['United States', 'US', 'U.S.A.'], 18],
  ['Google', ['Google LLC', 'google inc', 'Alphabet/Google'], 17],
]), show(helped));
ok('NEGATIVE CONTROL: a column of distinct names has no clusters', vc.clusterValues([['East', 3], ['West', 4], ['North', 1]]).length === 0);
ok('rules: one exact rule per value that changes', show(vc.mergeRules(plain)) === show([
  { from: 'Google LLC', to: 'Google' }, { from: 'google inc', to: 'Google' }, { from: 'U.S.A.', to: 'USA' },
]));

// ── check ─────────────────────────────────────────────────────────────────
const known = new Set(COUNTS.map((c) => c[0]));
ok('check: only the column\'s own values survive', show(vc.checkGroups([['US', 'USA', 'America', 7, null], ['Google', 'Gooogle'], 'US', ['Acme']], known)) === show([['US', 'USA']]));
ok('check: a value stays in its first group', show(vc.checkGroups([['US', 'USA'], ['USA', 'United States', 'U.S.A.']], known)) === show([['US', 'USA'], ['United States', 'U.S.A.']]));
ok('check: garbage in → no groups', vc.checkGroups('[]', known).length === 0 && vc.checkGroups(null, known).length === 0 && vc.checkGroups({ 0: ['US', 'USA'] }, known).length === 0);

async function endToEnd(): Promise<void> {
  const pid = (await projects.createProject('Similar values')).id;
  const rows: Array<[string, number]> = [];
  for (const [value, n] of COUNTS) for (let k = 0; k < n; k += 1) rows.push([value, k]);
  const ds = await datasets.saveDataset(pid, {
    name: 'Accounts', sourceKind: 'csv',
    columns: [{ name: 'company', type: 'text' }, { name: 'n', type: 'number' }] as Any,
    rows,
  });
  ok('fixture dataset saved', !!ds);
  if (!ds) return;

  const r = (await prepare.similarValues(pid, ds.id, -1, 'company', false)) as Any;
  ok('channel: the clusters, counted by the server', r.ok === true && r.distinct === COUNTS.length && r.more === 0 && show(r.clusters) === show(plain), show(r));

  // ── apply ───────────────────────────────────────────────────────────────
  const step = { type: 'replace_values', column: 'company', mode: 'exact', rules: vc.mergeRules(r.clusters) };
  const out = await datasets.updateSteps(pid, ds.id, [step]);
  const after = out ? out.dataset.rows.map((row) => String(row[0])) : [];
  const changed = after.filter((v, i) => v !== rows[i][0]).length;
  const expected = r.clusters.reduce((n: number, c: Any) => n + c.rows, 0);
  ok('apply: the step rewrites exactly the rows the suggestion counted', !!out && changed === expected && expected === 19, show([changed, expected]));
  ok('apply: one value per cluster is left', new Set(after).size === COUNTS.length - 3 && !after.includes('Google LLC') && after.filter((v) => v === 'Google').length === 55);
  const again = (await prepare.similarValues(pid, ds.id, -1, 'company', false)) as Any;
  ok('apply: nothing left to merge afterwards', again.ok === true && again.clusters.length === 0, show(again));

  // ── input ───────────────────────────────────────────────────────────────
  const before = (await prepare.similarValues(pid, ds.id, 0, 'company', false)) as Any;
  ok('input: a step at index 0 sees the values BEFORE the merge', before.ok === true && show(before.clusters) === show(plain), show(before));

  // ── refuse ──────────────────────────────────────────────────────────────
  const num = (await prepare.similarValues(pid, ds.id, -1, 'n', false)) as Any;
  const none = (await prepare.similarValues(pid, ds.id, -1, 'nope', false)) as Any;
  ok('refuse: a number column, an unknown column', num.ok === false && none.ok === false && typeof num.error === 'string');

  // ── assistant ───────────────────────────────────────────────────────────
  const asked = (await prepare.similarValues(pid, ds.id, 0, 'company', true)) as Any;
  ok('assistant: no model → the clusters still come back, with why', asked.ok === true && show(asked.clusters) === show(plain) && asked.assistant && asked.assistant.notReady === true, show(asked));
}

endToEnd()
  .catch((e) => { ok('no exception', false, e && e.stack); })
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
