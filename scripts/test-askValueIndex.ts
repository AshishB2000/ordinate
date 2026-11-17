// The Assistant's value index (docs/assistant/00-design.md, step 3 "Values, as built"): src/ipc/valueIndex.ts builds each
// dataset's sidecar (`<id>.values.parquet`, ../src/engine/valueIndexResident), src/ipc/askValues.ts reads it.
//
// 1. KEYS (pure): over every code point, a character and each case partner the rule matches alike (JS `iu`, the
//    reference's engine) share one key (NEGATIVE CONTROL: toLowerCase as the key does not: ſ and s, ς and σ); over the
//    value search's corpus, every value the rule matches for a word has a key in that word's range, so the index finds a
//    superset of the scan and the rule picks from it.
// With DATABASE_URL (real roles, ./rowPolicyHarness; the app wires the index with a database; without it, a skip line):
// 2. AFTER THE WRITE: a save returns before its dataset's build (its sidecar is not there yet, the build is tracked work),
//    and the dataset's next write waits for that build (the order of the Parquet writes); then every dataset saved has a
//    sidecar built from its last write; a column past MAX_DISTINCT is not held, nor a personal one, whose values are not
//    in the file at all. (Wide.code is names with a number, `Lot <n>`, so no column of sections 2 to 6 is id-like and the
//    differential below holds as before: an id-like column is section 8's.)
// 3. DIFFERENTIAL: the VALUES block from the index equals the scan's (the reference: `_setValueIndex(false)`) with
//    Object.is, over questions × callers (the admin, an editor, east and west with row locks on Orders, east's on Mixed,
//    nobody with Plain's region hidden) × scopes (each dataset alone, all at once); and through `copilot:ask`, the prompt
//    byte for byte. Cost: where the index holds every column, an admin's ask sends ONE DuckDB statement (the lookup over
//    every sidecar of the ask) and no other; east one confirmation a locked dataset with candidates; a confirmed value
//    keeps its leading BOM. Compared with VALUES_BUDGET_MS lifted on both sides (`_setValuesBudget`) and ⌘K's index
//    timers held, so a loaded machine cannot cut one side short (CONTROL after: the budget is back, a slow scan stops).
// 4. LOCK: NEGATIVE CONTROL: the index holds West's customer values (its lookup returns them: it knows no lock) and the
//    admin is told one; east never is, anywhere in the prompt. A value planted in the sidecar that the table does not
//    have (a stale index): east is never told it (no row confirms it); the admin is (without a lock the index is used as
//    is: the CONTROL that the planted row is read).
// 5. FALLBACKS: a dataset with no sidecar, or one from another write, is scanned (one statement) with the same block; so
//    is the column past the cap.
// 6. THE JOB (`values:index`) AND THE DELETES: a missing sidecar built; a column marked personal since: its values gone
//    from the file (CONTROL: unmarked, back); the Trash takes the sidecar with its dataset and a restore brings it back
//    fresh; a purge, deleteDataset and a project delete remove it; one whose dataset is gone is removed by the job.
// 7. BENCH (VALUE_INDEX_BENCH=1, slow; ./valueIndexHarness bench): 12 datasets of 1,000,000 rows and five text columns: a build, the lookup, the
//    scan and the confirmation, and what a write still costs, timed and printed (the numbers in the design doc).
// 8. ID-LIKE COLUMNS (./valueIndexHarness idLike): past the cap, the build marks a column id-like when nearly every value
//    is distinct and one token with a digit or an @; the ask scans it only for an id token of the question. A 50,000-name
//    column still finds Acme (scanned), as does a model name with a number (NEGATIVE CONTROLS: near-distinct, but names;
//    an id-shaped code that repeats); a ZIP code column under the cap stays held; a question with no digit or @ sends no
//    statement at all against a 1,000,000-row table of ids and emails (CONTROL: the scan does, and finds an email by its
//    domain: the loss, pinned), nor does a year ("in 2024"); "order 48213", "48213" alone and an email far down are found,
//    the id alone; east is never told an id of West's rows (CONTROL: the admin is, and east its own), also in the
//    statement that confirms her index values; a stale sidecar with the flag set, or none, is scanned as before.
//
//   npm run build:ts && [DATABASE_URL=…] [VALUE_INDEX_BENCH=1] node scripts/test-askValueIndex.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as RP from './rowPolicyHarness';
import { bench, counted, idLike, metasOf, rowsIn, setsOf, sidecarOf, withoutSearchIndex } from './valueIndexHarness';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const vs: typeof import('../src/engine/valueSearchResident') = require('../src/engine/valueSearchResident');
const vir: typeof import('../src/engine/valueIndexResident') = require('../src/engine/valueIndexResident');
const askValues: typeof import('../src/ipc/askValues') = require('../src/ipc/askValues');
const valueIndex: typeof import('../src/ipc/valueIndex') = require('../src/ipc/valueIndex');
const lifecycle: typeof import('../src/server/lifecycle') = require('../src/server/lifecycle');
const parquetStore: typeof import('../src/engine/parquetStore') = require('../src/engine/parquetStore');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const rec: typeof import('../src/data/datasetRecord') = require('../src/data/datasetRecord');
const access: typeof import('../src/data/columnAccess') = require('../src/data/columnAccess');
const catalog: typeof import('../src/app/catalog') = require('../src/app/catalog');
const trash: typeof import('../src/app/trash') = require('../src/app/trash');
const trashStore: typeof import('../src/app/trashStore') = require('../src/app/trashStore');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const analyze: typeof import('../src/ai/analyze') = require('../src/ai/analyze');
const execConfig: typeof import('../src/app/execConfig') = require('../src/app/execConfig');

type Cell = import('../src/data/transforms').Cell;
const T = (name: string) => ({ name, type: 'text' as const });
const N = (name: string) => ({ name, type: 'number' as const });
const HEAD = 'VALUES THE QUESTION NAMES';

// ── 1. Keys ──────────────────────────────────────────────────────────────────

// The value search's corpus (scripts/test-askValueSearch.ts): case, accents, folding, CJK, a BOM, long values, empties.
const MIXED: Cell[] = ['West', 'west', 'WEST', 'Westfield', 'North-West', 'Northwest', 'Mid West Coast', ' West ', '', null, '   ', 'EU', 'Europe',
  'eu-central', 'US', 'USA', 'us', 'Tech', 'Technology', 'Hi-Tech', 'café West', 'Ñandú', 'ÑANDÚ sur', '\uFEFFWest', 'x'.repeat(56) + ' west',
  'é'.repeat(25) + ' west', '東京 West', '😀 west', 'Straße', 'STRASSE', 'ΔΈΛΤΑΣ', '\u212Ailo', 'İstanbul', 'tech_west', 'Δέλτα west', 'Acme Corp', 'acme', 'ACME Inc.', '007 West', 'Wes', 'wes',
  'ſtraße', 'µ-meter', 'ꭰꭱ', 'Ꭰ'];
const WORDS = ['west', 'eu', 'us', 'tech', 'ñandú', 'straße', 'strasse', 'acme', 'wes', '东京', '東京', 'δέλτα', 'δέλτας', 'kilo', 'istanbul', 'i̇stanbul',
  'stra', 'μ', 'ꭰꭱ', 'ꭰ', 'inc', 'corp'];

function keys(): void {
  // Every code point's case partners among its own mappings; the rule's engine says which match it.
  const esc = (c: string) => `\\u{${c.codePointAt(0)!.toString(16)}}`;
  let pairs = 0;
  let bad = '';
  let naive = 0;
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    const u = c.toUpperCase();
    const l = c.toLowerCase();
    const partners = [u, l, u.toLowerCase(), l.toUpperCase()].filter((d) => d !== c && Array.from(d).length === 1);
    if (!partners.length) continue;
    const re = new RegExp(`^${esc(c)}$`, 'iu');
    for (const d of new Set(partners)) {
      if (!re.test(d)) continue;
      pairs++;
      if (vs.wordKey(c) !== vs.wordKey(d) && !bad) bad = `U+${cp.toString(16)} vs U+${d.codePointAt(0)!.toString(16)}`;
      if (c.toLowerCase() !== d.toLowerCase()) naive++;
    }
  }
  ok(`keys: every code point and each case partner the rule matches alike share one key (${pairs} pairs)`, !bad && pairs > 2_000, bad);
  ok(`keys: NEGATIVE CONTROL: lower case as the key would part ${naive} of them (ſ and s, ς and σ…)`, naive > 0
    && 'ſ'.toLowerCase() !== 's' && vs.wordKey('ſ') === vs.wordKey('s') && vs.wordKey('ς') === vs.wordKey('σ') && vs.wordKey(String.fromCodePoint(0x212a)) === vs.wordKey('k'));
  let checked = 0;
  let missed = '';
  for (const v of MIXED) {
    if (typeof v !== 'string') continue;
    const ks = vs.valueKeys(v);
    for (const w of WORDS) {
      if (!vs.valueMatches(v, [w])) continue;
      checked++;
      const [lo, hi] = vs.keyRange(w);
      if (!ks.some((k) => k >= lo && k < hi) && !missed) missed = `${JSON.stringify(v)} for ${w}: ${JSON.stringify(ks)} not in [${lo}, ${hi})`;
    }
  }
  ok(`keys: every value the rule matches for a word has a key in that word's range (${checked} matches)`, !missed && checked > 40, missed);
  const [lo, hi] = vs.keyRange('eu');
  ok('keys: a short word\'s range is its own key alone; a long one\'s every key it starts', 'EU' >= lo && 'EU' < hi && !('EUROPE' < hi)
    && vs.keyRange('west')[0] === 'WEST' && 'WESTFIELD' < vs.keyRange('west')[1] && !('WESU' < vs.keyRange('west')[1]));
}

// ── The world ────────────────────────────────────────────────────────────────

let lastPrompt = '';
function stubModel(): void {
  (execConfig as { executionReady: unknown }).executionReady = async () => true;
  (analyze as { askCopilot: unknown }).askCopilot = async (_prior: unknown, facts: string) => {
    lastPrompt = facts;
    return { ok: true, text: 'Fine.', suggestedAction: { kind: 'none', intent: '' } };
  };
}

interface Seeded { mixed: string; wide: string; all: string[] }
const WIDE_ROWS = 10_050; // its `code` column is past MAX_DISTINCT
const WIDE_CODE = 'Westgate 5017';

async function seed(W: RP.World): Promise<Seeded> {
  return W.as('boss', async () => {
    const save = async (name: string, columns: Array<{ name: string; type: 'text' | 'number' }>, rows: Cell[][]) => (await datasets.saveDataset(W.P, { name, sourceKind: 'csv', columns, rows }))!.id;
    const L = MIXED.length;
    const mixed = await save('Mixed', [T('a'), T('b'), T('contact'), N('n')], [...MIXED, ...MIXED.slice().reverse()].map((v, i) => [v, MIXED[(i * 7) % L], i % 2 ? 'Westley Smith' : 'Ann Lee', i]));
    await lifecycle.settleWork(); // its build, set off by the save
    await catalog.setColumn(W.P, mixed, 'contact', { sensitivity: 'personal' });
    if (!(await valueIndex.buildValueIndex(W.P, mixed))) throw new Error('fixture: the build after the mark'); // as the job does
    // A second lock for east, on Mixed's `b`: its confirmations then carry a leading BOM, accents and folded case.
    const rule = await W.call('boss', 'dataset:setRowPolicy', { projectId: W.P, datasetId: mixed, policy: { column: 'b', rules: [{ teamId: W.team, values: ['\uFEFFWest', 'Westfield', 'EU', 'Straße', 'Acme Corp', 'Δέλτα west', 'İstanbul'] }] } });
    if (rule.body?.ok !== true) throw new Error(`fixture: Mixed's rule ${rule.text}`);
    const wide = await save('Wide', [T('code'), T('kind')], Array.from({ length: WIDE_ROWS }, (_, i) => [i === 5017 ? WIDE_CODE : `Lot ${i}`, ['Westgate', 'Other', 'Acme'][i % 3]]));
    await lifecycle.settleWork();
    return { mixed, wide, all: [W.orders, W.east, W.west, W.plain, mixed, wide] };
  });
}

async function both<T>(fn: () => Promise<T>): Promise<{ on: T; off: T }> {
  const on = await fn();
  askValues._setValueIndex(false);
  try {
    return { on, off: await fn() };
  } finally {
    askValues._setValueIndex(true);
  }
}

const block = (W: RP.World, who: string, ids: readonly string[], q: string) =>
  W.as(who, async () => (await askValues.askValueFacts(W.P, await metasOf(W, who, ids), [], q)).text);

const QUESTIONS = ['sales in West', 'east and north', 'canary customers', `${RP.W_CANARY} sales`, 'c1 c2 c3', 'west eu tech acme ñandú straße',
  'kilo δέλτας istanbul', 'us wes', 'westley smith', 'westgate acme other', 'k-17 westgate', 'atlantis'];
const CALLERS = ['boss', 'ed', 'east', 'west', 'nobody'];

async function hide(W: RP.World, on: boolean): Promise<void> {
  const done = await W.as('boss', () => rec.serialized(rec.datasetFilePath(W.P, W.plain), (raw) => {
    raw.columnAccess = on ? access.buildColumnAccess(raw, [{ column: 'region', visibleTo: [{ teamId: W.team }] }], 'boss@acme.test', new Date().toISOString()) : undefined;
    return true;
  }));
  if (!done) throw new Error('fixture: the column rule');
}

// ── 2. After the write ───────────────────────────────────────────────────────

async function afterWrite(W: RP.World, s: Seeded): Promise<void> {
  // A save returns first; its build follows in the dataset's write chain, and the next write of the dataset waits for it.
  const order: string[] = [];
  const realWrite = parquetStore.writeTableAsync;
  (parquetStore as { writeTableAsync: unknown }).writeTableAsync = async (file: string, ...rest: Parameters<typeof realWrite> extends [string, ...infer R] ? R : never) => {
    order.push(file.endsWith('.values.parquet') ? 'values' : 'table');
    return realWrite(file, ...rest);
  };
  try {
    const cols = [T('region')];
    const d = await W.as('boss', async () => (await datasets.saveDataset(W.P, { name: 'Brief', sourceKind: 'csv', columns: cols, rows: [['West']] }))!.id);
    const file = await sidecarOf(W, d);
    const before = { exists: fs.existsSync(file), pending: lifecycle.pendingWork().length };
    ok('after the write: a save returns before its build: no sidecar yet, the build is tracked work', !before.exists && before.pending > 0, JSON.stringify(before));
    await W.as('boss', () => datasets.updateDatasetData(W.P, d, { columns: cols, rows: [['East'], ['North']] }));
    await lifecycle.settleWork();
    ok('after the write: the next write of the dataset waits for that build (table, values, table, values)', order.join() === 'table,values,table,values', order.join());
    const [meta] = await metasOf(W, 'boss', [d]);
    ok('after the write: CONTROL: settled, the sidecar is there, built from the last write', (await setsOf(W, [d])).get(d)?.stamp === vir.stampOf(meta) && (await rowsIn(W, d, "c2 = 'North'")) === 1);
    await W.as('boss', () => datasets.deleteDataset(W.P, d));
    ok('delete: deleteDataset removes the sidecar with the table', !fs.existsSync(file));
  } finally {
    (parquetStore as { writeTableAsync: unknown }).writeTableAsync = realWrite;
  }

  const sets = await setsOf(W, s.all);
  const metas = await metasOf(W, 'boss', s.all);
  const fresh = metas.every((m) => sets.get(m.id)?.stamp === vir.stampOf(m) && sets.get(m.id)?.version === vir.VALUE_INDEX_VERSION);
  ok('built: every dataset saved has a sidecar built from its last write', fresh && metas.length === s.all.length, JSON.stringify([...sets.entries()]));
  ok('built: Orders holds its text columns (region, customer), not its number or date ones', sets.get(W.orders)?.indexed.join() === '0,3', JSON.stringify(sets.get(W.orders)));
  ok('built: a column marked personal is not held (Mixed.contact), its marks recorded', sets.get(s.mixed)?.indexed.join() === '0,1' && sets.get(s.mixed)?.marked.join() === 'contact', JSON.stringify(sets.get(s.mixed)));
  ok(`built: a column past ${vir.MAX_DISTINCT} distinct values is not held (Wide.code), the other is; names, so not id-like`, sets.get(s.wide)?.indexed.join() === '1' && sets.get(s.wide)?.idLike.join() === '', JSON.stringify(sets.get(s.wide)));
  const all = await rowsIn(W, s.mixed);
  const personal = await rowsIn(W, s.mixed, "c2 = 'Westley Smith'");
  ok('built: a personal column\'s values are not in the sidecar at all', all > 50 && personal === 0, `${all} ${personal}`);
}

// ── 3. The differential ──────────────────────────────────────────────────────

async function differential(W: RP.World, s: Seeded): Promise<void> {
  // Complete results on both sides: under load the reference's scans ran past VALUES_BUDGET_MS and skipped datasets the
  // index answered (seen at a load average of 24). The budget itself: the control at the end.
  askValues._setValuesBudget(Infinity);
  try {
    await compared(W, s);
  } finally {
    askValues._setValuesBudget();
  }
  const real = vs.searchValuesResident;
  (vs as { searchValuesResident: unknown }).searchValuesResident = async (...a: Parameters<typeof real>) => {
    const r = await real(...a);
    await new Promise((done) => setTimeout(done, askValues.VALUES_BUDGET_MS + 50));
    return r;
  };
  try {
    const slow = await both(() => block(W, 'boss', [W.plain, s.mixed], 'west'));
    ok('DIFFERENTIAL: CONTROL: the budget is back after it: a first statement past VALUES_BUDGET_MS, the dataset after it skipped',
      slow.off.includes('- Plain.region = "West"') && !slow.off.includes('Mixed.') && slow.on.includes('- Mixed.a = "West"'), JSON.stringify(slow));
  } finally {
    (vs as { searchValuesResident: unknown }).searchValuesResident = real;
  }
}

async function compared(W: RP.World, s: Seeded): Promise<void> {
  await hide(W, true);
  try {
    const scopes = [...s.all.map((id) => [id]), s.all];
    let cases = 0, found = 0, bad = '';
    for (const q of QUESTIONS) for (const who of CALLERS) for (const ids of scopes) {
      const { on, off } = await both(() => block(W, who, ids, q));
      cases++;
      if (on) found++;
      if (!Object.is(on, off) && !bad) bad = `${who} "${q}" over ${ids.length}: ${JSON.stringify(on)} vs ${JSON.stringify(off)}`;
    }
    ok(`DIFFERENTIAL: the index's VALUES block equals the scan's, Object.is (${cases} cases, ${found} with a block)`, !bad && found > 100, bad);
    const hiddenOff = await block(W, 'nobody', [W.plain], 'sales in West');
    ok('DIFFERENTIAL: …a column hidden from the caller is never answered from the index (Plain.region, nobody)', !hiddenOff.includes('Plain.region'), hiddenOff);
  } finally {
    await hide(W, false);
  }
  const shown = await block(W, 'nobody', [W.plain], 'sales in West');
  ok('DIFFERENTIAL: …CONTROL: unhidden, it is', shown.includes('- Plain.region = "West"'), shown);

  // Through the real route, the prompt byte for byte.
  const ask = async (who: string, payload: object) => {
    lastPrompt = '';
    const threadId = (await W.call(who, 'copilot:newThread', { projectId: W.P })).body.thread.id;
    const r = await W.call(who, 'copilot:ask', { projectId: W.P, ...payload, threadId });
    return { reply: r.body, prompt: lastPrompt };
  };
  const routes: Array<[string, object]> = [['boss', { context: { kind: '' }, question: 'sales in West for acme' }], ['east', { context: { kind: '' }, question: 'sales in West and East' }],
    ['boss', { context: { kind: 'dataset', id: s.mixed }, question: 'west eu tech' }], ['west', { context: { kind: '' }, question: 'canary customers in west' }]];
  let same = true, detail = '';
  for (const [who, payload] of routes) {
    const { on, off } = await both(() => ask(who, payload));
    if (on.prompt !== off.prompt || on.reply?.ok !== true || !on.prompt.includes(HEAD)) {
      same = false;
      detail ||= `${who}: ${on.prompt.slice(on.prompt.indexOf(HEAD), on.prompt.indexOf(HEAD) + 300)} vs ${off.prompt.slice(off.prompt.indexOf(HEAD), off.prompt.indexOf(HEAD) + 300)}`;
    }
  }
  ok(`DIFFERENTIAL: through copilot:ask the prompt is byte for byte the scan's (${routes.length} asks, each with a block)`, same, detail);

  // Cost, where the index holds every column the caller may search (Orders, Plain, Mixed).
  const held = [W.orders, W.plain, s.mixed];
  const admin = await counted(() => block(W, 'boss', held, 'sales in West for acme'));
  ok('cost: an admin\'s ask sends no scan and no confirmation where the index holds every column, and is answered', admin.duck === 0 && admin.value.includes('- Orders.region = "West"') && admin.value.includes('- Mixed.a = "West"'), JSON.stringify(admin));
  ok('cost: the lookup is ONE DuckDB statement over every sidecar of the ask', admin.lookups === 1, JSON.stringify(admin));
  const east = await counted(() => block(W, 'east', held, 'sales in West and East'));
  ok('cost: east (row locks on Orders and Mixed) sends one confirmation a locked dataset, and no scan', east.duck === 2 && east.scans === 0 && east.value.includes('- Orders.region = "East"'), JSON.stringify(east));
  const bom = await block(W, 'east', [s.mixed], 'west');
  ok('cost: …a confirmed value keeps its leading BOM (Mixed.b, east)', bom.includes('"\uFEFFWest"') && bom === (await both(() => block(W, 'east', [s.mixed], 'west'))).off, JSON.stringify(bom));
  const off = await counted(async () => {
    askValues._setValueIndex(false);
    try { return await block(W, 'boss', held, 'sales in West for acme'); } finally { askValues._setValueIndex(true); }
  });
  ok('cost: CONTROL: the scan sends one statement a dataset and no lookup', off.scans === 3 && off.lookups === 0, JSON.stringify(off));
}

// ── 4. The row lock ──────────────────────────────────────────────────────────

async function lock(W: RP.World): Promise<void> {
  const q = 'canary customers';
  const range = vs.keyRange('canary'); // W_CANARY_7f19_<i>: its words are W, CANARY, 7f19 and <i>
  const raw = await W.as('east', async () => vir.lookupValuesResident([{ datasetId: W.orders, path: await sidecarOf(W, W.orders), ranges: [range] }]));
  const held = [...(raw?.get(W.orders)?.columns.get(3)?.values ?? [])].map(([v]) => v);
  ok('lock: NEGATIVE CONTROL: the index alone hands east West\'s customer values (it knows no lock)', held.some((v) => v.startsWith(RP.W_CANARY)), JSON.stringify(held));
  const boss = await block(W, 'boss', [W.orders], `${RP.W_CANARY} ${q}`);
  const east = await block(W, 'east', [W.orders], `${RP.W_CANARY} ${q}`);
  ok('lock: …the admin is told one', boss.includes(`- Orders.customer = "${RP.W_CANARY}_`), boss);
  ok('lock: …east never is: every value found is confirmed under the lock', !RP.leaks(east) && !east.includes('Orders.customer'), east);

  // A stale index: a value the table does not have, planted in Orders' sidecar under its current stamp.
  const file = await sidecarOf(W, W.orders);
  await W.as('boss', async () => {
    const rows = (await duck.queryAsync(`SELECT c0, c1, c2, c3 FROM read_parquet('${file}')`)).map((r) => [r.c0, Number(r.c1), r.c2, Number(r.c3)] as Cell[]);
    await parquetStore.writeTableAsync(file, vir.SIDECAR_COLUMNS, [...rows, ['WESTEROS', 0, 'Westeros', 0]]);
  });
  try {
    const eastStale = await block(W, 'east', [W.orders], 'sales in westeros');
    const bossStale = await block(W, 'boss', [W.orders], 'sales in westeros');
    ok('lock: a stale index\'s value the table no longer has is never shown to a locked caller (east)', !eastStale.includes('Westeros'), eastStale);
    ok('lock: …CONTROL: the planted row is read: the admin, with no lock, is given the index as is', bossStale.includes('- Orders.region = "Westeros"'), bossStale);
  } finally {
    await W.as('boss', () => valueIndex.buildValueIndex(W.P, W.orders));
  }
}

// ── 5. Fallbacks ─────────────────────────────────────────────────────────────

async function fallbacks(W: RP.World, s: Seeded): Promise<void> {
  const q = 'west eu tech acme';
  const want = await (async () => {
    askValues._setValueIndex(false);
    try { return await block(W, 'boss', [s.mixed], q); } finally { askValues._setValueIndex(true); }
  })();
  fs.rmSync(await sidecarOf(W, s.mixed));
  const none = await counted(() => block(W, 'boss', [s.mixed], q));
  ok('fallback: a dataset with no sidecar is scanned (one statement), the same block', none.scans === 1 && none.value === want && want.includes(HEAD), JSON.stringify(none));
  const [mixedMeta] = await metasOf(W, 'boss', [s.mixed]);
  const older: import('../src/engine/valueIndexResident').ValueSet = { version: vir.VALUE_INDEX_VERSION, stamp: 'older', indexed: [0, 1], idLike: [], marked: [] };
  await W.as('boss', async () => parquetStore.writeTableAsync(await sidecarOf(W, s.mixed), vir.SIDECAR_COLUMNS, vir.sidecarRows(older, [])));
  const stale = await counted(() => block(W, 'boss', [s.mixed], q));
  ok('fallback: a sidecar built from another write is not read: scanned, the same block', stale.scans === 1 && stale.value === want && vir.stampOf(mixedMeta) !== 'older', JSON.stringify(stale));
  await W.as('boss', () => valueIndex.buildValueIndex(W.P, s.mixed));
  const again = await counted(() => block(W, 'boss', [s.mixed], q));
  ok('fallback: CONTROL: rebuilt, the index answers it with no statement', again.duck === 0 && again.value === want, JSON.stringify(again));
  const wide = await counted(() => block(W, 'boss', [s.wide], 'westgate'));
  ok('fallback: the column past the cap is scanned, the held one answered with it, in column order', wide.scans === 1
    && wide.value.endsWith(`\n- Wide.code = "${WIDE_CODE}"\n- Wide.kind = "Westgate"`), JSON.stringify(wide));
}

// ── 6. The job and the deletes ───────────────────────────────────────────────

async function job(W: RP.World, s: Seeded): Promise<void> {
  const setOf = async (id: string) => (await setsOf(W, [id])).get(id) ?? null;
  const run = () => W.as('boss', () => valueIndex.indexOrgValues());
  fs.rmSync(await sidecarOf(W, W.plain));
  ok('job: CONTROL: Plain has no sidecar', !(await setOf(W.plain)));
  await run();
  const [meta] = await metasOf(W, 'boss', [W.plain]);
  ok('job: a missing sidecar is built', (await setOf(W.plain))?.stamp === vir.stampOf(meta) && (await rowsIn(W, W.plain)) > 0);

  await W.as('boss', () => catalog.setColumn(W.P, s.mixed, 'b', { sensitivity: 'personal' }));
  ok('job: CONTROL: a column marked since its build is still in the file until the job runs', (await rowsIn(W, s.mixed, "c1 = '1'")) > 0);
  ok('job: …but no ask is answered from it meanwhile (withheld)', !(await block(W, 'boss', [s.mixed], 'west eu tech acme')).includes('Mixed.b'));
  await run();
  ok('job: a column marked personal since: its values are gone from the file, it is not held', (await rowsIn(W, s.mixed, "c1 = '1'")) === 0 && (await setOf(s.mixed))?.indexed.join() === '0');
  await W.as('boss', () => catalog.setColumn(W.P, s.mixed, 'b', { sensitivity: 'none' }));
  await run();
  ok('job: CONTROL: unmarked, it is held again', (await rowsIn(W, s.mixed, "c1 = '1'")) > 0 && (await setOf(s.mixed))?.indexed.join() === '0,1');

  const orphan = path.join(path.dirname(await sidecarOf(W, W.plain)), '00000000-0000-4000-8000-000000000000.values.parquet');
  fs.copyFileSync(await sidecarOf(W, W.plain), orphan);
  await run();
  ok('job: a sidecar whose dataset is gone is removed (CONTROL: Plain\'s stays)', !fs.existsSync(orphan) && fs.existsSync(await sidecarOf(W, W.plain)));

  const wideFile = await sidecarOf(W, s.wide);
  const trashed = path.join(await W.as('boss', async () => trashStore.trashDir(W.P, 'dataset')), path.basename(wideFile));
  const t = await W.as('boss', () => trash.trashRecord(W.P, 'dataset', s.wide));
  await run();
  ok('trash: the sidecar goes with its dataset, and the job leaves it be', t.ok && !fs.existsSync(wideFile) && fs.existsSync(trashed));
  await W.as('boss', () => trash.restore(W.P, 'dataset', s.wide));
  const back = await counted(() => block(W, 'boss', [s.wide], 'westgate'));
  ok('trash: …restored, it is back and read as it was', fs.existsSync(wideFile) && back.lookups === 1 && back.value.includes('- Wide.kind = "Westgate"'), JSON.stringify(back));
  await W.as('boss', () => trash.trashRecord(W.P, 'dataset', s.wide));
  await W.as('boss', () => trash.purge(W.P, 'dataset', s.wide));
  ok('purge: a dataset purged from the Trash leaves no sidecar', !fs.existsSync(trashed) && !fs.existsSync(wideFile));

  const P2: string = (await W.call('boss', 'projects:create', { name: 'Gone' })).body.id;
  const d2 = await W.as('boss', async () => (await datasets.saveDataset(P2, { name: 'Brief', sourceKind: 'csv', columns: [T('region')], rows: [['West'], ['East']] }))!.id);
  await lifecycle.settleWork();
  const f2 = await W.as('boss', async () => rec.valuesPath(P2, d2));
  ok('project delete: CONTROL: its dataset has a sidecar', fs.existsSync(f2));
  await W.as('boss', () => projects.deleteProject(P2));
  ok('project delete: no sidecar left', !fs.existsSync(f2));
}

(async () => {
  keys();
  if (!process.env.DATABASE_URL) {
    console.log('skip the value index: DATABASE_URL is unset (the app builds it with a database, whose job backfills it)');
    return;
  }
  stubModel();
  const W = await RP.world('value index');
  if (!W) return;
  try {
    // ⌘K's index timers, set off by these saves, would otherwise land in the differential's asks.
    const s = await withoutSearchIndex(async (held) => {
      const seeded = await seed(W);
      await afterWrite(W, seeded);
      await differential(W, seeded);
      ok('DIFFERENTIAL: CONTROL: the saves did schedule ⌘K\'s index builds (Mixed, Wide, Brief twice at least), held until it is done', held() >= 4, String(held()));
      return seeded;
    });
    await lock(W);
    await fallbacks(W, s);
    await idLike(W);
    await job(W, s);
    if (process.env.VALUE_INDEX_BENCH === '1') await bench(W);
  } finally {
    await W.close();
  }
})()
  .catch((e) => ok('value-index suite ran to the end', false, e && e.stack ? e.stack : String(e)))
  .finally(finish);
