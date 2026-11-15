// A restricted caller's hidden-column checks off step 3's index (docs/assistant/00-design.md, "Scale rules": no
// Assistant question lists the whole project): ../src/data/rowAccess hiddenAnywhere reads only the datasets the index
// says may hide a column (../src/server/assistantSearchIndex hidingDatasets), and ../src/analysis/columnHidden
// metricHidden finds the metrics a formula names by their name keys (../src/ipc/specVocabulary metricsSaidIn). Each is
// held Object.is-equal to its reference, the same code with the index off (../src/ipc/assistantSearch `_setIndexed`):
// every dataset walked, every metric listed.
//
// Always (no database):
//   1. The name keys of a formula's stretches (../src/data/columnAccess mentionable) find every metric mentionsHidden
//      would match: over formulas × names (brackets, spaces, punctuation, digits, `_`, a final sigma, a dotted İ, an
//      astral letter, a name at either end, one inside another), mentionsHidden(formula, {name}) ⇒ lowerKey(name) is
//      among them. Its premise, over every code point: lowercasing twice is lowercasing once. NEGATIVE CONTROL: the
//      stretches from the start only miss names.
//   2. A formula past the stretch cap gives null (every metric is read instead); without a database both lookups are
//      null: the reference paths.
// With DATABASE_URL (scripts/columnAccessHarness.ts's world: Staff hides salary, ssn and bonus from all but HR):
//   3. THE DATASET DIFFERENTIAL: hiddenAnywhere, sorted, index on === off, for boss (admin), ed (editor), east and
//      nobody (viewers HR's rules hide from), hr (a viewer they do not) and a fan-out, over: Staff's own rules; Pay copy
//      built from Staff and Pay rollup from that (two levels), a union of Pay copy; a join on Staff; a chain of 18 with
//      no rules (the walk runs out: the last one hides every column); a cycle; rules that do not sanitize; one built from
//      a dataset that never was; a record holding another dataset's id. Then a rule added and one removed (the index
//      follows each write: the marker is not rebuilt), a ruled dataset moved to the Trash with one built from it, and a
//      dataset deleted. The candidates are few: not Orders, not Plain, not the chain's middle.
//   4. NEGATIVE CONTROLS: with Pay rollup's `up:` key to Pay copy taken out of the index, and with the union of Pay copy
//      missing from it, the differential FAILS; a rebuild mends each.
//   5. THE METRIC DIFFERENTIAL: metricHidden of every metric, index on === off, for the same callers: formula chains, a
//      formula naming one that names a hidden-column metric, two cycles, a chain past MAX_DEPTH, two metrics of one name
//      in another case (the first in listMetrics' order wins), a name inside another, punctuation and a sigma; then one
//      renamed and one deleted. The specMetrics vocabulary agrees too. With the index on no metric list is read
//      (recordFs.listRecords of metrics/ spied); NEGATIVE CONTROL: off, it is; with Pay's name key taken out of the
//      index, the differential FAILS.
//
//   npm run build:ts && [DATABASE_URL=…] node scripts/test-hiddenIndex.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as C from './columnAccessHarness';

const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const search: typeof import('../src/ipc/assistantSearch') = require('../src/ipc/assistantSearch');
const index: typeof import('../src/server/assistantSearchIndex') = require('../src/server/assistantSearchIndex');
const sv: typeof import('../src/ipc/specVocabulary') = require('../src/ipc/specVocabulary');
const rowAccess: typeof import('../src/data/rowAccess') = require('../src/data/rowAccess');
const hiddenMod: typeof import('../src/analysis/columnHidden') = require('../src/analysis/columnHidden');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
const answers: typeof import('../src/ipc/answers') = require('../src/ipc/answers');
const { randomUUID }: typeof import('crypto') = require('crypto');

const same = (a: readonly unknown[], b: readonly unknown[]): boolean => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/** `fn` with the index on, then off (the reference). */
async function both<T>(fn: () => Promise<T>): Promise<[T, T]> {
  const on = await fn();
  search._setIndexed(false);
  try {
    return [on, await fn()];
  } finally {
    search._setIndexed(true);
  }
}

// ── 1, 2: the stretches, without a database ────────────────────────────────

function keysLeg(): void {
  let twice = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const l = String.fromCodePoint(cp).toLowerCase();
    if (l.toLowerCase() !== l) twice++;
  }
  ok(`1. lowercasing twice is lowercasing once, for every code point (${twice} differ)`, twice === 0);

  const names = ['Pay', 'pay', 'Pay band', 'Gross (USD)', 'net_rev', 'ΣΑΣ', 'Café Σ', 'İstanbul', '𝐀𝐁 total', 'a', '7 day', 'Revenue', 'x-y', '%margin', 'Ünits'];
  const formulas = ['[Pay]', '[Heads] / [PAY]', '[pay band]*2', '[Gross (USD)] - [Net_Rev]', 'σας + 1', '[CAFÉ Σ] + [ΣΑΣ]', 'İSTANBUL', 'i̇stanbul', '[𝐀𝐁 TOTAL]', 'a', 'A+a',
    '[7 day]/7', 'revenue', 'Revenue_x', 'x-y-z', '(%margin)', '[ünits]', 'pay  band', '', '   ', '[[Pay]]', 'sum(pay)'];
  const random = (seed: number) => () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
  const rnd = random(7);
  const pieces = [...names, '[', ']', ' ', '+', '_', '(', ')', 'x', 'Σ', '𝐀', '-', '/'];
  for (let i = 0; i < 300; i++) formulas.push(Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => pieces[Math.floor(rnd() * pieces.length)]).join(''));
  const keysOf = (f: string, only?: (t: string) => boolean): Set<string> => new Set((access.mentionable(f, 100_000) ?? []).filter((t) => !only || only(t)).map(search.lowerKey));
  const missed: string[] = [];
  let mentioned = 0;
  for (const f of formulas) {
    const keys = keysOf(f);
    for (const n of names) if (access.mentionsHidden(f, new Set([n]))) {
      mentioned++;
      if (!keys.has(search.lowerKey(n))) missed.push(`${n} in ${f}`);
    }
  }
  ok(`1. every name a formula mentions is among its stretches' keys (${mentioned} mentions over ${formulas.length} formulas)`, missed.length === 0 && mentioned > 50, missed.slice(0, 5));
  const fromStart = formulas.filter((f) => [...names].some((n) => access.mentionsHidden(f, new Set([n])) && !keysOf(f, (t) => f.toLowerCase().trimStart().startsWith(t)).has(search.lowerKey(n))));
  ok(`1. NEGATIVE CONTROL: the stretches from the start only miss names (${fromStart.length} formulas)`, fromStart.length > 10);

  const long = Array.from({ length: 200 }, (_, i) => `[m${i}]`).join('+');
  ok('2. a formula of more stretches than the cap gives null: every metric is read instead', access.mentionable(long, 2_000) === null && access.mentionable('[a]+[b]', 2_000) !== null);
}

async function noDbLeg(): Promise<void> {
  const P = '11111111-1111-4111-8111-111111111111';
  ok('2. without a database the candidates and a formula\'s names are null: the reference paths', (await search.hidingModel(P)) === null && (await sv.metricsSaidIn(P, '[Pay]')) === null);
}

// ── 3–5: with a database ─────────────────────────────────────────────────────

type W = C.ColumnWorld;
const WHO = ['boss', 'ed', 'east', 'nobody', 'hr'] as const;

async function datasetLeg(W: W): Promise<void> {
  const { P, staff, plain } = W;
  const save = (name: string, cols: string[]) => W.as('boss', async () => (await datasets.saveDataset(P, { name, sourceKind: 'csv', columns: cols.map((c) => ({ name: c, type: 'text' as const })), rows: [cols.map(() => 'x')] }))!.id);
  const write = (id: string, fn: (r: Record<string, unknown>) => void) => W.as('boss', () => rec.serialized(rec.datasetFilePath(P, id), (r) => { fn(r); return true; }));
  const from = (id: string, origin: object) => write(id, (r) => { r.origin = origin; });

  const payCopy = await save('Pay copy', ['pc_total']);
  await from(payCopy, { kind: 'sql', deps: [staff] });
  const rollup = await save('Pay rollup', ['rollup_col']);
  await from(rollup, { kind: 'combined', leftId: payCopy, rightId: plain });
  const union = await save('Union', ['union_col']);
  await write(union, (r) => { r.steps = [{ type: 'union', datasetId: payCopy }]; });
  const join = await save('Join', ['join_col']);
  await from(join, { kind: 'composed', baseId: plain, joins: [{ datasetId: staff }] });
  const chain: string[] = [];
  for (let i = 0; i < 18; i++) {
    chain.push(await save(`Deep ${i}`, [`deep_${i}`]));
    if (i) await from(chain[i], { kind: 'sql', deps: [chain[i - 1]] });
  }
  const [cx, cy] = [await save('Cycle x', ['cyc_x']), await save('Cycle y', ['cyc_y'])];
  await from(cx, { kind: 'sql', deps: [cy] });
  await from(cy, { kind: 'sql', deps: [cx] });
  const closed = await save('Closed', ['closed_col']);
  await W.setRaw(closed, 'not rules');
  const orphan = await save('Orphan', ['orphan_col']);
  await from(orphan, { kind: 'sql', deps: [randomUUID()] });
  const trashed = await save('Ruled', ['t_secret', 't_open']);
  await W.plant(trashed, [{ column: 't_secret', visibleTo: [{ teamId: W.hrTeam }] }]);
  const kid = await save('Ruled kid', ['kid_col']);
  await from(kid, { kind: 'sql', deps: [trashed] });
  const odd = randomUUID(); // a record that holds Pay copy's id: listed under that id, its own keys not trusted
  await W.as('boss', async () => recordFs.writeFile(rec.datasetFilePath(P, odd), JSON.stringify({ ...(await W.rawOf(payCopy)), name: 'Odd' }), 'utf8'));

  const callers: Array<[string, () => Promise<string[]>]> = [
    ...WHO.map((who): [string, () => Promise<string[]>] => [who, () => W.as(who, async () => [...(await rowAccess.hiddenAnywhere(P))].sort())]),
    ['fan-out', () => W.as('boss', async () => [...(await rowAccess.fanOutScope(() => rowAccess.hiddenAnywhere(P))).value].sort())],
  ];
  const differential = async (): Promise<string[]> => {
    const bad: string[] = [];
    for (const [who, get] of callers) {
      const [on, off] = await both(get);
      if (!same(on, off)) bad.push(`${who}: ${JSON.stringify(on)} vs ${JSON.stringify(off)}`);
    }
    return bad;
  };
  const builtAt = async (): Promise<string> => String((await W.pool.query("SELECT built_at FROM assistant_search_built WHERE project_id = $1 AND source = 'datasets'", [P])).rows[0]?.built_at);
  const east = () => callers[2][1]();

  let bad = await differential();
  ok(`3. every caller's hidden columns are the reference's, Object.is (${callers.length} callers)`, bad.length === 0, bad);
  const e = await east();
  const want = ['salary', 'ssn', 'bonus', 'pc_total', 'rollup_col', 'union_col', 'join_col', 'deep_17', 'closed_col', 't_secret', 'kid_col'];
  ok('3. …and the world is what it says: east has Staff\'s, the derived ones\' (two levels, a union, a join), the chain\'s tail, the closed and the ruled', want.every((c) => e.includes(c)) && !['deep_16', 'cyc_x', 'orphan_col', 'region'].some((c) => e.includes(c)), e);
  const hr = await callers[4][1]();
  ok('3. …hr is not hidden HR\'s columns, still the chain\'s tail and the closed one', !hr.includes('salary') && !hr.includes('pc_total') && hr.includes('deep_17') && hr.includes('closed_col'), hr);
  const boss = await callers[0][1]();
  ok('3. …an admin and an editor have none', boss.length === 0 && (await callers[1][1]()).length === 0);
  const cands = new Set((await W.as('east', () => search.hidingModel(P))) ?? []);
  ok('3. the candidates are the ruled, what is built from them and the chain\'s tail: not Orders, not Plain, not the chain\'s middle',
    [staff, payCopy, rollup, union, join, chain[17], closed, trashed, kid, orphan].every((id) => cands.has(id)) && ![W.orders, plain, chain[5], chain[16]].some((id) => cands.has(id)), cands.size);

  const before = await builtAt();
  await W.plant(plain, [{ column: 'customer', visibleTo: [{ teamId: W.hrTeam }] }]);
  bad = await differential();
  ok('3. a rule added: the same, and east now has Plain\'s customer and what is built from Plain', bad.length === 0 && (await east()).includes('customer') && (await east()).includes('join_col'), bad);
  await W.setRaw(plain, undefined);
  bad = await differential();
  ok('3. the rule removed: the same, and customer is back', bad.length === 0 && !(await east()).includes('customer'), bad);
  ok('3. …the index followed both writes: the datasets marker was not rebuilt', before !== 'undefined' && (await builtAt()) === before, [before, await builtAt()]);
  const moved = await W.call('boss', 'dataset:delete', { projectId: P, id: trashed });
  bad = await differential();
  ok('3. a ruled dataset moved to the Trash: the same, and the one built from it still hides (its rules are kept there)', moved.status === 200 && bad.length === 0 && (await east()).includes('kid_col') && !(await east()).includes('t_secret'), bad.length ? bad : moved.text.slice(0, 200));
  await W.as('boss', () => datasets.deleteDataset(P, join));
  bad = await differential();
  ok('3. a dataset deleted: the same, and its columns are gone', bad.length === 0 && !(await east()).includes('join_col'), bad);

  // (Pay copy's own up: key would not do: the odd record holding its id keeps it a candidate, as it should.)
  const rebuilt = async (): Promise<string[]> => { await W.pool.query('DELETE FROM assistant_search_built WHERE project_id = $1', [P]); return differential(); };
  await W.pool.query("UPDATE assistant_search SET keys = array_remove(keys, $1) WHERE project_id = $2 AND base AND kind = 'dataset' AND id = $3", [index.upKey(payCopy), P, rollup]);
  bad = await differential();
  ok('4. NEGATIVE CONTROL: with Pay rollup\'s up: key to Pay copy out of the index, the differential FAILS', bad.length > 0 && !(await east()).includes('rollup_col'), bad);
  ok('4. …and a rebuild mends it', (await rebuilt()).length === 0);
  await W.pool.query("DELETE FROM assistant_search WHERE project_id = $1 AND base AND kind = 'dataset' AND id = $2", [P, union]);
  bad = await differential();
  ok('4. NEGATIVE CONTROL: with the union of Pay copy missing from the index, the differential FAILS', bad.length > 0 && !(await east()).includes('union_col'), bad);
  ok('4. …and a rebuild mends it', (await rebuilt()).length === 0);
}

async function metricLeg(W: W): Promise<void> {
  const { P, staff } = W;
  const ids: Record<string, string> = {};
  const save = async (name: string, definition: object) => { ids[name] = (await W.as('boss', () => metrics.saveMetric(P, { name, datasetId: staff, definition })))!.id; };
  const sum = (column: string) => ({ column, aggregation: 'sum' });
  await save('Pay', sum('salary'));
  await save('Heads', { column: 'employee_id', aggregation: 'count' });
  await save('Heads per pay', { formula: '[Heads] / [Pay]' });
  await save('Ratio x2', { formula: '[Heads per pay] * 2' });
  await save('Plain ratio', { formula: '[Heads] + 1' });
  await save('Loop A', { formula: '[Loop B] + 1' });
  await save('Loop B', { formula: '[Loop A] + 1' });
  await save('Loop C', { formula: '[Loop D]' });
  await save('Loop D', { formula: '[Loop C] + [Pay]' });
  await save('Step 0', { formula: '[Pay]' });
  for (let i = 1; i <= 12; i++) await save(`Step ${i}`, { formula: `[Step ${i - 1}] + 0` });
  await save('Dup', { column: 'salary', aggregation: 'max' });
  await save('dup', { column: 'employee_id', aggregation: 'count' });
  await save('Uses dup', { formula: '[DUP] * 1' });
  await save('Pay band', { column: 'employee_id', aggregation: 'count' });
  await save('Banded', { formula: '[Pay band] + 0' });
  await save('Gross (USD)', sum('salary'));
  await save('Net', { formula: '[Gross (USD)] - 1' });
  await save('Café Σ', sum('salary'));
  await save('Uses café', { formula: '[CAFÉ Σ] + [Heads]' });
  await save('Names nothing', { formula: '[Nobody here] + 1' });

  const every = () => Object.values(ids);
  const callers: Array<[string, () => Promise<boolean[]>]> = [
    ...WHO.map((who): [string, () => Promise<boolean[]>] => [who, () => W.as(who, () => Promise.all(every().map((id) => hiddenMod.metricHidden(P, id))))]),
    ['fan-out', () => W.as('boss', async () => (await rowAccess.fanOutScope(() => Promise.all(every().map((id) => hiddenMod.metricHidden(P, id))))).value)],
  ];
  const differential = async (): Promise<string[]> => {
    const bad: string[] = [];
    for (const [who, get] of callers) {
      const [on, off] = await both(get);
      if (!same(on, off)) bad.push(`${who}: ${Object.keys(ids).filter((_, i) => on[i] !== off[i]).join(', ')}`);
    }
    return bad;
  };
  const eastOf = async (): Promise<Record<string, boolean>> => { const h = await callers[2][1](); return Object.fromEntries(Object.keys(ids).map((n, i) => [n, h[i]])); };

  let bad = await differential();
  ok(`5. every metric's hidden check is the reference's, Object.is (${every().length} metrics × ${callers.length} callers)`, bad.length === 0, bad);
  const e = await eastOf();
  ok('5. …and the world is what it says for east: Pay, a formula naming it, one naming that, a cycle reaching it, Net, Banded (a name inside another), a sigma\'s: hidden; Heads, Plain ratio, the other cycle, Step 12 (past the depth): not',
    ['Pay', 'Heads per pay', 'Ratio x2', 'Loop C', 'Loop D', 'Step 0', 'Net', 'Banded', 'Dup', 'Uses café'].every((n) => e[n]) && !['Heads', 'Plain ratio', 'Loop A', 'Loop B', 'Step 12', 'Names nothing', 'dup'].some((n) => e[n]), e);
  const [vOn, vOff] = await both(() => W.as('east', async () => (await answers.specMetrics(P)).map((m) => m.id)));
  ok('5. the specMetrics vocabulary is the same, index on and off', same(vOn, vOff) && vOn.length > 0, [vOn.length, vOff.length]);

  let lists = 0; // a whole metrics directory listed: listMetrics' (and metricsByName's, through it) read
  const real = recordFs.listRecords;
  (recordFs as { listRecords: unknown }).listRecords = (dir: string) => { if (/[\\/]metrics$/.test(dir)) lists++; return real(dir); };
  let off = 0;
  try {
    await callers[2][1]();
    const on = lists;
    search._setIndexed(false);
    try { await callers[2][1](); } finally { search._setIndexed(true); }
    off = lists - on;
    ok(`5. with the index on, no metric list is read (${on})`, on === 0);
  } finally {
    (recordFs as { listRecords: unknown }).listRecords = real;
  }
  ok(`5. NEGATIVE CONTROL: with it off, the metrics are listed (${off})`, off > 0);

  await W.pool.query("UPDATE assistant_search SET keys = array_remove(keys, $1) WHERE project_id = $2 AND base AND kind = 'metric' AND id = $3", [search.lowerKey('Pay'), P, ids.Pay]);
  bad = await differential();
  ok('5. NEGATIVE CONTROL: with Pay\'s name key out of the index, the differential FAILS', bad.length > 0 && !(await eastOf())['Heads per pay'], bad);
  await W.pool.query('DELETE FROM assistant_search_built WHERE project_id = $1', [P]);
  ok('5. …and a rebuild mends it', (await differential()).length === 0);

  await W.as('boss', () => metrics.updateMetric(P, ids.Pay, { name: 'Payroll total' }));
  bad = await differential();
  ok('5. Pay renamed: the same, and a formula saying [Pay] no longer reads it', bad.length === 0 && !(await eastOf())['Heads per pay'] && (await eastOf()).Pay, bad);
  await W.as('boss', () => metrics.deleteMetric(P, ids['Gross (USD)']));
  bad = await differential();
  ok('5. Gross (USD) deleted: the same, and Net no longer reads it', bad.length === 0 && !(await eastOf()).Net, bad);
}

(async () => {
  keysLeg();
  await noDbLeg();
  const W = await C.columnWorld('the hidden-column index');
  if (!W) return;
  try {
    await datasetLeg(W);
    await metricLeg(W);
  } finally {
    await W.close();
  }
})()
  .catch((e) => ok('hidden-column index suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(() => finish());
