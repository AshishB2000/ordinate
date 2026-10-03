// Self-check for data-quality rules: the sanitizer, the regex subset, and the
// DIFFERENTIAL between the JS reference (`analysis/qualityRules.evaluateRuleJs`)
// and the resident path (`engine/qualityResident.evaluateRulesResident`).
//
// Every rule kind runs over ONE fixture built to break a sloppy implementation:
// null / '' / space / tab / NBSP cells, a leading BOM, `007` beside `7` in a
// text column, a non-numeric cell in a number column, duplicates, dates in both
// canonical shapes plus an impossible and a non-canonical one, and a references
// pair (text keys and number keys). The reference runs on the ROUND-TRIPPED rows
// (`parquetStore.readTable`), and `failing`, `passed`, `error` and every sample
// cell are compared with `Object.is` — a hand-written expectation can agree with
// a bug on both sides; an equivalence cannot.
//
// The regex section runs BOTH engines: accepted patterns must agree on every
// probe string, and the divergences the subset exists to refuse are pinned so a
// future "just allow \s" has to delete a failing test first.
//
//   npm run build:ts && node scripts/test-qualityRules.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const crypto: typeof import('crypto') = require('crypto');
const Module: any = require('module');

type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type RuleResult = import('../src/analysis/qualityRules').RuleResult;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-quality-'));
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: () => tmpUserData, getVersion: () => '0.0.0-test' }, ipcMain: { handle: () => {}, on: () => {} } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

const pqSync: typeof import('../src/engine/parquetStoreSync') = require('../src/engine/parquetStoreSync');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
const rules: typeof import('../src/analysis/qualityRules') = require('../src/analysis/qualityRules');
const rx: typeof import('../src/analysis/qualityRegex') = require('../src/analysis/qualityRegex');
const resident: typeof import('../src/engine/qualityResident') = require('../src/engine/qualityResident');

const id = (): string => crypto.randomUUID();
const T = (name: string): ParsedColumn => ({ name, type: 'text' });
const N = (name: string): ParsedColumn => ({ name, type: 'number' });
const D = (name: string): ParsedColumn => ({ name, type: 'date' });

// ── 1. The sanitizer ─────────────────────────────────────────────────────────
{
  const base = { id: id(), kind: 'not_null', column: 'a', args: {}, severity: 'fail' };
  ok('a well-formed rule survives', rules.sanitizeRule(base) !== null);
  ok('a non-UUID id is dropped', rules.sanitizeRule({ ...base, id: 'nope' }) === null);
  ok('an unknown kind is dropped', rules.sanitizeRule({ ...base, kind: 'median' }) === null);
  ok('a missing column is dropped', rules.sanitizeRule({ ...base, column: '' }) === null);
  ok('an unknown severity reads as fail', rules.sanitizeRule({ ...base, severity: 'loud' })!.severity === 'fail');
  ok('stray args are dropped', Object.keys(rules.sanitizeRule({ ...base, args: { pattern: 'x', evil: 1 } })!.args).length === 0);
  const range = (args: unknown) => rules.sanitizeRule({ ...base, kind: 'range', args });
  ok('range with no bounds is dropped', range({}) === null);
  ok('range with min > max is dropped', range({ min: 5, max: 1 }) === null);
  ok('range with a non-date string is dropped', range({ min: 'yesterday' }) === null);
  ok('range with an impossible date is dropped', range({ min: '2024-02-30' }) === null);
  ok('range mixing a number and a date is dropped', range({ min: 1, max: '2024-01-01' }) === null);
  ok('range with date bounds survives', range({ min: '2024-01-01', max: '2024-12-31' }) !== null);
  ok('range keeps only min/max', JSON.stringify(range({ min: 0, max: 1, values: ['x'] })!.args) === '{"min":0,"max":1}');
  const rc = (args: unknown) => rules.sanitizeRule({ id: id(), kind: 'row_count', args });
  ok('row_count needs whole, non-negative bounds', rc({ min: 1.5 }) === null && rc({ min: -1 }) === null && rc({ min: 10 }) !== null);
  ok('row_count carries no column', rc({ min: 1, column: 'x' })!.column === undefined);
  const set = (values: unknown) => rules.sanitizeRule({ ...base, kind: 'in_set', args: { values } });
  ok('in_set with no values is dropped', set([]) === null && set('open') === null);
  ok('in_set dedupes and drops blanks, keeps numbers as text',
    JSON.stringify(set(['a', 'a', ' ', 7, null, {}])!.args.values) === '["a","7"]');
  ok('in_set over the cap is dropped', set(Array.from({ length: 201 }, (_, i) => 'v' + i)) === null);
  const ref = (args: unknown) => rules.sanitizeRule({ ...base, kind: 'references', args });
  ok('references needs a UUID dataset', ref({ datasetId: '../x', column: 'c' }) === null);
  ok('references needs a column', ref({ datasetId: id() }) === null);
  const re = (args: unknown) => rules.sanitizeRule({ ...base, kind: 'regex', args });
  ok('regex with an unsupported pattern is dropped', re({ pattern: '\\s+' }) === null);
  ok('a regex preset supplies its own pattern', re({ preset: 'email', pattern: 'ignored' })!.args.pattern === rx.REGEX_PRESETS.email.pattern);
  const check = rules.checkRule({ ...base, kind: 'regex', args: { pattern: '(?=a)' } });
  ok('checkRule says WHY a rule is refused', !check.ok && /lookaround/i.test(check.error), JSON.stringify(check));

  const dup = { ...base };
  const q = rules.sanitizeQuality({
    rules: [dup, dup, { kind: 'bogus' }, ...Array.from({ length: 60 }, () => ({ ...base, id: id() }))],
    latest: { at: 'x', results: [{ ruleId: base.id, passed: false, failing: 2, sample: [['a', 1, NaN]] }, { ruleId: id(), passed: true, failing: 0, sample: [] }] },
    history: Array.from({ length: 40 }, (_, i) => ({ at: String(i), passed: 1, failed: 0, failing: { [base.id]: i, bad: 1 } })),
  })!;
  ok('sanitizeQuality keeps each rule id once and caps the list', q.rules.length === rules.MAX_RULES && q.rules.filter((r) => r.id === base.id).length === 1);
  ok('a result for an unknown rule is dropped', q.latest!.results.length === 1);
  ok('a sample row with a non-finite cell is dropped', q.latest!.results[0].sample.length === 0);
  ok('history is capped at 30, newest kept', q.history!.length === 30 && q.history![29].at === '39');
  ok('history keys that are not rule ids are dropped', Object.keys(q.history![0].failing).join() === base.id);
  ok('no rules → no quality block', rules.sanitizeQuality({ rules: [] }) === undefined);

  // appendRun: latest + one history line per run, capped.
  let cur = rules.sanitizeQuality({ rules: [base] })!;
  for (let i = 0; i < 33; i += 1) cur = rules.appendRun(cur, [{ ruleId: base.id, passed: i % 2 === 0, failing: i % 2, sample: [] }], `t${i}`);
  ok('appendRun keeps the last 30 runs', cur.history!.length === 30 && cur.history![0].at === 't3' && cur.latest!.at === 't32');
  ok('appendRun counts passed/failed rules', cur.history![29].passed === 1 && cur.history![28].failed === 1);
  ok('qualityFailingCount counts failing FAIL rules only',
    rules.qualityFailingCount({ rules: [base, { ...base, id: id(), severity: 'warn' } as any], latest: { at: 'x', results: [
      { ruleId: base.id, passed: false, failing: 1, sample: [] },
    ] } }) === 1);
}

// ── 2. The JS-only semantics a stored table cannot show ─────────────────────
{
  const r = rules.sanitizeRule({ id: id(), kind: 'range', column: 'n', args: { min: 0 } })!;
  const res = rules.evaluateRuleJs(r, [N('n')], [[5], ['abc' as Cell], [null], [-1]]);
  ok('in memory, a non-numeric cell in a number column fails a range', res.failing === 2, JSON.stringify(res));
  const miss = rules.evaluateRuleJs({ ...r, column: 'gone' }, [N('n')], [[1]]);
  ok('a rule on a missing column is passed:false with an error, not a crash',
    miss.passed === false && miss.failing === 0 && /no longer exists/.test(miss.error || ''));
}

// ── 3. The regex subset ──────────────────────────────────────────────────────
const ACCEPTED = [
  ...Object.values(rx.REGEX_PRESETS).map((p) => p.pattern),
  'open|closed', '[0-9]{3}', '[A-Z][a-z]+', 'a.c', '(ab)+', '(?:x|y)*z?', '[^a-c]+', '\\d{2}-\\w+',
  'café', '[a-]+', '\\.', 'a{2,3}', '^abc$', '\u{1F600}+', 'a*?b', '[\\]\\-\\\\]+', '\\t|\\n', '[a-z0-9._%+-]+',
];
const REFUSED: Array<[string, RegExp]> = [
  ['\\s+', /whitespace/], ['\\S', /whitespace/], ['(?=a)a', /lookaround/i], ['(?<n>a)', /named/i], ['(?i)abc', /flags/i],
  ['(a)\\1', /Back-reference/], ['\\bword', /boundar/i], ['[[:alpha:]]', /inside a class/], ['a{1001}', /1000/],
  ['a{', /lone/], ['}', /lone/], [']', /lone/], ['*a', /Nothing to repeat/], ['a**', /Nothing to repeat/], ['[]', /empty/i],
  ['[z-a]', /out of order/], ['\\p{L}', /not supported/], ['\\u0041', /not supported/], ['a)', /Unmatched/], ['(a', /Unclosed/],
  ['[a', /Unclosed/], ['', /Enter/], ['x'.repeat(201), /under 200/], ['[a-c-e]', /follows a range/], ['[\\d-z]', /range/],
];
const PROBES = ['', 'abc', 'a\nc', 'a\rc', 'a\u2028c', 'open', 'closed', 'OPEN', '007', '12-ab_c', 'café', 'cafe\u0301',
  '---a', '.', 'aa', 'aaaa', '\u{1F600}\u{1F600}', '\u00a0', 'x@y.co', 'ann@x.com', '+1 (555) 123-4567', '12345-6789',
  '2024-01-05', 'ab', 'aab', 'b', ']-\\', '\t', '\n', 'Ab', 'abcx'];

for (const p of ACCEPTED) ok(`accepted: /${p}/`, rx.checkPattern(p) === null, rx.checkPattern(p) || '');
for (const [p, why] of REFUSED) {
  const msg = rx.checkPattern(p);
  ok(`refused: /${p.length > 20 ? p.slice(0, 20) + '…' : p}/ — ${why}`, msg !== null && why.test(msg), String(msg));
}

async function main(): Promise<void> {
  if (!duck.isAvailable()) {
    console.log('#    DuckDB bridge UNAVAILABLE — the resident half is not under test');
    return;
  }
  const re2 = (s: string, p: string): boolean | string => {
    try {
      return String(duck.query('SELECT regexp_full_match(?, ?) AS m', [s, p])[0].m) === 'true';
    } catch (e: any) {
      return 'error: ' + e.message;
    }
  };

  // Every accepted pattern reads the same in both engines, probe by probe.
  for (const p of ACCEPTED) {
    const js = rx.jsRegex(p);
    const bad = PROBES.filter((s) => js.test(s) !== re2(s, rx.re2Pattern(p)));
    ok(`JS and RE2 agree on /${p}/ over ${PROBES.length} probes`, bad.length === 0, JSON.stringify(bad));
  }

  // THE PINNED DIVERGENCES — why each refusal exists. If one of these stops
  // diverging, the subset can grow; until then the refusal stands.
  ok('pinned: \\s matches NBSP in JS but not in RE2',
    /^(?:\s)$/su.test('\u00a0') === true && re2('\u00a0', '(?s)\\s') === false);
  ok('pinned: without dotAll, `.` differs on \\r (JS no, RE2 yes) — hence the s / (?s) flags',
    /^(?:.)$/u.test('\r') === false && re2('\r', '.') === true && rx.jsRegex('.').test('\r') && re2('\r', rx.re2Pattern('.')) === true);
  let posixJs: string;
  try { posixJs = String(rx.jsRegex('[[:alpha:]]').test('a')); } catch { posixJs = 'error'; }
  ok('pinned: [[:alpha:]] is a POSIX class to RE2 and a syntax error to JS', re2('a', '[[:alpha:]]') === true && posixJs === 'error');
  ok('pinned: lookahead works in JS and is an error in RE2', /^(?:(?=a)a)$/u.test('a') && String(re2('a', '(?=a)a')).startsWith('error'));
  ok('pinned: a back-reference works in JS and is an error in RE2', /^(?:(a)\1)$/u.test('aa') && String(re2('aa', '(a)\\1')).startsWith('error'));
  ok('pinned: RE2 caps a repeat at 1000', String(re2('a', 'a{1001}')).startsWith('error') && re2('a', 'a{1,1000}') === true);

  // ── 4. The differential: every rule kind, both engines, one fixture ─────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-quality-fx-'));
  const mainCols = [T('code'), T('name'), N('amount'), D('day'), T('email'), T('status'), T('cust'), N('qty')];
  const mainRows: Cell[][] = [
    ['007', 'Ann', 10, '2024-01-05', 'ann@x.com', 'open', 'C1', 1],
    ['7', null, 20.5, '2024-1-7', 'bad-email', 'closed', 'C2', 2],
    ['007', '', -3, '1/15/2024', '', 'OPEN', 'C9', 2],
    ['008', '   ', null, '2024-02-30', null, 'open', '', 3],
    ['009', '\t', 'abc' as Cell, 'Jan 5 2024', 'x@y.co', 'pending', 'C1', null],
    ['010', '\u00a0', 1e6, '', 'a.b@c.org', ' open', 'c1', 5],
    [null, 'Bob', 0, null, 'bob@z.io ', 'closed', 'C3', 7],
    ['011', 'Bob', 10, '2023-12-31', '\ufeffbom@x.com', 'open', 'C2', 1],
    ['\ufeff012', 'Cy', 99.99, '2024-12-31', 'cy@x.com', 'open', null, 8],
    ['013', 'Di', 10, '2025-01-01', 'di@x', 'closed', 'C4', 9],
    ['014', ' Ed', 55, '2024-06-15', 'ed@x.com', '', 'C5', 1],
    ['015', 'Fay', 7, '2024-06-15', 'fay@x.com', 'open', ' C1', 10],
  ];
  const refCols = [T('cid'), N('num')];
  const refRows: Cell[][] = [['C1', 10], ['C2', 20.5], ['C3', 7], ['C4', null], [null, 0], ['', 99.99], ['  ', 1], ['C1', 55]];
  const mainFile = path.join(tmp, 'main.parquet');
  const refFile = path.join(tmp, 'ref.parquet');
  pqSync.writeTable(mainFile, mainCols, mainRows);
  pqSync.writeTable(refFile, refCols, refRows);
  const mainBack = pqSync.readTable(mainFile, mainCols);
  const refBack = pqSync.readTable(refFile, refCols);
  ok('fixtures read back', !!mainBack && !!refBack);
  if (!mainBack || !refBack) return;

  const REF = id();
  const GONE = id();
  const R = (kind: string, column: string | undefined, args: any = {}, severity = 'fail'): any => {
    const r = rules.sanitizeRule({ id: id(), kind, column, args, severity });
    if (!r) throw new Error(`fixture rule refused: ${kind}(${column}) ${JSON.stringify(args)}`);
    return r;
  };
  const list = [
    ...mainCols.map((c) => R('not_null', c.name)),
    R('unique', 'code'), R('unique', 'name'), R('unique', 'amount'), R('unique', 'day'), R('unique', 'qty'), R('unique', 'cust'),
    R('range', 'amount', { min: 0, max: 100 }), R('range', 'amount', { min: 0 }), R('range', 'amount', { max: 50 }),
    R('range', 'qty', { min: 1, max: 9 }), R('range', 'day', { min: '2024-01-01', max: '2024-12-31' }), R('range', 'day', { min: '2024-06-01' }),
    R('regex', 'email', { preset: 'email' }), R('regex', 'status', { pattern: 'open|closed' }), R('regex', 'code', { pattern: '[0-9]{3}' }),
    R('regex', 'day', { preset: 'date' }), R('regex', 'name', { pattern: '[A-Z][a-z]+' }), R('regex', 'code', { preset: 'zip' }),
    R('regex', 'code', { preset: 'phone' }),
    R('in_set', 'status', { values: ['open', 'closed'] }), R('in_set', 'code', { values: ['007', '7'] }),
    R('in_set', 'amount', { values: ['10', '7', '0', 'abc', '007'] }), R('in_set', 'qty', { values: ['1', '2'] }),
    R('in_set', 'amount', { values: ['abc'] }),
    R('row_count', undefined, { min: 5 }), R('row_count', undefined, { max: 5 }), R('row_count', undefined, { min: 1, max: 100 }),
    R('references', 'cust', { datasetId: REF, column: 'cid' }), R('references', 'amount', { datasetId: REF, column: 'num' }),
    R('references', 'qty', { datasetId: REF, column: 'num' }),
    // Rules that cannot run — both engines must say so, identically.
    R('not_null', 'gone'), R('range', 'name', { min: 1 }), R('range', 'amount', { min: '2024-01-01' }), R('regex', 'amount', { pattern: '1' }),
    R('references', 'cust', { datasetId: GONE, column: 'cid' }), R('references', 'cust', { datasetId: REF, column: 'num' }),
    R('references', 'cust', { datasetId: REF, column: 'nope' }), R('range', 'day', { min: 1 }),
  ];

  const refTable = { columns: refCols, rows: refBack.rows };
  const js = list.map((r) => rules.evaluateRuleJs(r, mainCols, mainBack.rows,
    r.kind === 'references' ? (r.args.datasetId === REF ? refTable : null) : undefined));
  const refs = new Map<string, { parquetPath: string; columns: ParsedColumn[] } | null>([[REF, { parquetPath: refFile, columns: refCols }], [GONE, null]]);
  const res = await resident.evaluateRulesResident({ parquetPath: mainFile, columns: mainCols }, list, refs);
  ok('resident answered every rule (not a fallback)', Array.isArray(res) && res.length === list.length);
  if (!res) return;

  const sameCells = (a: Cell[][], b: Cell[][]): boolean =>
    a.length === b.length && a.every((row, i) => row.length === b[i].length && row.every((c, j) => Object.is(c, b[i][j])));
  list.forEach((r, i) => {
    const a: RuleResult = js[i];
    const b: RuleResult = res[i];
    const label = `${rules.ruleSignature(r)} ${JSON.stringify(r.args)}`;
    ok(`${label}: failing ${a.failing} === resident`, Object.is(a.failing, b.failing) && a.passed === b.passed && a.ruleId === b.ruleId,
      `js=${a.failing}/${a.passed} resident=${b.failing}/${b.passed}`);
    ok(`${label}: error agrees`, (a.error || '') === (b.error || ''), `js=${a.error} resident=${b.error}`);
    ok(`${label}: sample agrees cell for cell`, sameCells(a.sample, b.sample), JSON.stringify([a.sample, b.sample]));
  });

  // A few absolute anchors, so the two engines cannot agree on nonsense.
  const at = (sig: string, args = ''): RuleResult => js[list.findIndex((r) => rules.ruleSignature(r) === sig && (!args || JSON.stringify(r.args) === args))];
  ok('anchor: not_null(name) counts null, \'\', space, tab and NBSP', at('not_null(name)').failing === 5);
  ok('anchor: not_null(amount) counts null and the non-numeric cell', at('not_null(amount)').failing === 2);
  ok('anchor: unique(code) — 007 twice, 7 is a different text value', at('unique(code)').failing === 2);
  ok('anchor: unique(name) — both Bobs', at('unique(name)').failing === 2);
  ok('anchor: in_set(code) keeps 007 and 7 apart', at('in_set(code)').failing === 8);
  ok('anchor: range(day) flags the impossible and the non-canonical date', at('range(day)', '{"min":"2024-01-01","max":"2024-12-31"}').failing === 4);
  ok('anchor: references(cust) — C9, c1, " C1" and C5 are not customers', at('references(cust)', `{"datasetId":"${REF}","column":"cid"}`).failing === 4);
  ok('anchor: samples are in stored order', JSON.stringify(at('unique(code)').sample.map((r) => r[0])) === '["007","007"]');
  ok('anchor: a BOM survives into the sample', at('regex(email)').sample.some((r) => r[4] === '\ufeffbom@x.com'));
  ok('anchor: row_count fails outside its bounds only', at('row_count', '{"max":5}').failing === 1 && at('row_count', '{"min":5}').failing === 0);

  // ── 5. The page predicate is the counted predicate ─────────────────────────
  const page: typeof import('../src/engine/datasetPage') = require('../src/engine/datasetPage');
  for (const r of list.filter((x) => x.kind !== 'row_count')) {
    const i = list.indexOf(r);
    if (js[i].error) continue;
    const ref = r.kind === 'references' ? refs.get(r.args.datasetId) ?? null : undefined;
    const sql = resident.failingRowSql({ parquetPath: mainFile, columns: mainCols }, r, ref);
    const keepFor = (cols: ParsedColumn[], rows: Cell[][]) => {
      const p = rules.failingPredicateJs(r, cols, rows, r.kind === 'references' ? refTable : undefined);
      if ('error' in p) throw new Error(p.error);
      return p.test;
    };
    const req = { offset: 0, limit: 100, rowFilter: { sql: sql ? sql.sql : null, params: sql ? sql.params : [], keepFor } };
    const fast = await page.readPage({ parquetPath: mainFile, columns: mainCols }, req);
    const slow = page.pageRowsJs(mainCols, mainBack.rows, req);
    ok(`${rules.ruleSignature(r)}: failing-row page total === failing count (both paths)`,
      !!fast && fast.total === js[i].failing && slow.total === js[i].failing && sameCells(fast.rows, slow.rows),
      `fast=${fast && fast.total} slow=${slow.total} count=${js[i].failing}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

void main()
  .catch((err) => { ok('unexpected error', false, err && err.stack); })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' quality-rule check(s) FAILED'); process.exit(1); }
    console.log('\nAll quality-rule checks passed.');
    process.exit(0); // the DuckDB worker keeps the loop alive otherwise
  });
