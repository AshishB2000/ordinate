'use strict';

// Self-check for SQL on Live datasets, F1 (docs/live-data/01-live-sql.md): the translator
// (src/engine/live/sql/tree.ts) and the printer (print.ts, view.ts), with DuckDB's parser in-process
// and no warehouse.
//
//   1. Golden shapes for the six dialects: the view CTE (the lock, the base filters, the readings),
//      generated names only, every literal a placeholder, F-D5's DOUBLE, F-D8's order and LIMIT.
//   2. ADVERSARIAL LITERALS and IDENTIFIERS per dialect: a statement written with a hostile literal
//      prints the IDENTICAL text as with a harmless one (the value lives only in `params`); a model
//      alias, a quoted name or a comment changes nothing printed; a record's hostile column name
//      reaches the text only through `ident()`. CONTROL: a printer that inlines a literal is caught.
//   3. The REFUSAL TABLE (./liveSqlCorpus.ts REFUSED: every construct F1 refuses and every R-L
//      threat), each refused with its code and its PASSING TWIN translated; where the guard is a
//      table entry, widening that entry stops the refusal (a NEGATIVE CONTROL per guard).
//   4. The KEY CENSUS (F-D2): every node and key DuckDB emits for the whole corpus is classified.
//      CONTROL: a key added to a fixture tree is refused, and the census names it.
//   5. The view: the lock clause is there (CONTROL: a view built without the lock fails the same
//      check), on a hidden column too; a lock that cannot apply refuses; hidden columns are absent;
//      a calc is computed only when read.
//
//   npm run build:ts && node scripts/test-liveSqlCompile.js

import { ok, finish } from './selfcheck';
import type { CompileDialectId, SqlDialect } from '../src/engine/live/dialect';
import type { LiveColumn } from '../src/engine/live/liveSpec';
import type { FilterStep } from '../src/data/transforms';
import type { SqlEnv } from '../src/engine/live/sql/tree';
import type { ViewInput } from '../src/engine/live/sql/view';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-livesqlc-'));
process.env.ORDINATE_LOCAL_DIR = tmp;

const tree: typeof import('../src/engine/live/sql/tree') = require('../src/engine/live/sql/tree');
const print: typeof import('../src/engine/live/sql/print') = require('../src/engine/live/sql/print');
const shapes: typeof import('../src/engine/live/sql/shapes') = require('../src/engine/live/sql/shapes');
const dialects: typeof import('../src/engine/live/dialects') = require('../src/engine/live/dialects');
const corpus: typeof import('./liveSqlCorpus') = require('./liveSqlCorpus');
const fx: typeof import('./liveParityFixture') = require('./liveParityFixture');
const golden: typeof import('./liveSqlGolden') = require('./liveSqlGolden');

const COLS: LiveColumn[] = [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'order_date', type: 'date' }, { name: 'note', type: 'text' }];
const LOCK: FilterStep[] = [{ type: 'filter', column: 'region', op: 'in', values: ['East'], lock: true } as FilterStep];
const INPUT: ViewInput = { env: { source: { kind: 'table', parts: ['ANALYTICS', 'ORDERS'] }, columns: COLS, base: [{ kind: 'compare', column: 'amount', op: '>', value: 0 }] }, lock: LOCK };
const ENV: SqlEnv = { tables: new Map([['orders', { id: 'o1', columns: COLS }], ['targets', { id: 't1', columns: corpus.TARGET_COLUMNS }]]), today: '2026-11-15' };
/** The corpus's vocabulary: the parity fixture as `orders`, and `targets`. */
const CORPUS_ENV: SqlEnv = { tables: new Map([['orders', { id: 'orders', columns: fx.COLUMNS }], ['targets', { id: 'targets', columns: corpus.TARGET_COLUMNS }]]), today: '2026-11-15' };
const TARGETS_INPUT: ViewInput = { env: { source: { kind: 'table', parts: ['ANALYTICS', 'TARGETS'] }, columns: corpus.TARGET_COLUMNS }, lock: [] };
const ALL = dialects.DIALECT_IDS;

type Printed = { ok: true; sql: string; params: { type: string; value: unknown }[] } | { ok: false; code: string; message: string };

async function compileSql(sql: string, dialect: CompileDialectId | SqlDialect, env: SqlEnv = ENV, inputs: (id: string) => ViewInput = (id) => (id === 'o1' || id === 'orders' ? INPUT : TARGETS_INPUT)): Promise<Printed> {
  const t = tree.translate(await tree.parseSql(sql), env);
  if (!t.ok) return t;
  const p = print.printLiveSql(t.ir, t.ir.views.map((v) => inputs(v.id)), dialect);
  return p.ok ? { ok: true, sql: p.query.sql, params: p.query.params } : { ok: false, code: p.code, message: p.message };
}

async function goldenShapes(): Promise<void> {
  for (const d of ALL) {
    const p = await compileSql(golden.A_SQL, d);
    ok(`golden ${d}: the note's example — view CTE (lock, base filter, readings), generated names, placeholders, DOUBLE, explicit order`, p.ok && p.sql === golden.A[d], p.ok ? `\n${p.sql}` : p.message);
  }
  const a = await compileSql(golden.A_SQL, 'duckdb');
  ok('golden duckdb: the parameters in text order — the lock East, the base 0, the date, the LIKE pattern', a.ok && JSON.stringify(a.params.map((p) => p.value)) === JSON.stringify([0, 'East', '2024-01-01', 'E!!%']), a.ok ? JSON.stringify(a.params) : '');

  const sets: Record<CompileDialectId, string> = { duckdb: 'EXCEPT', redshift: 'EXCEPT', snowflake: 'EXCEPT', databricks: 'EXCEPT', bigquery: 'EXCEPT DISTINCT', clickhouse: 'EXCEPT DISTINCT' };
  for (const d of ALL) {
    const p = await compileSql('SELECT region FROM orders EXCEPT SELECT region FROM targets ORDER BY region', d);
    ok(`golden ${d}: EXCEPT spelled ${sets[d]}, read through a derived table, ordered NULLS LAST, LIMIT 501`, p.ok && p.sql.includes(` ${sets[d]} SELECT `) && /\) AS w\d+ ORDER BY w\d+\.o_0 ASC NULLS LAST LIMIT 501$/.test(p.sql), p.ok ? p.sql : p.message);
    const w = await compileSql('SELECT region, sum(amount) OVER (PARTITION BY region ORDER BY order_date DESC ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS s, rank() OVER (ORDER BY amount) AS r FROM orders', d);
    ok(`golden ${d}: a window — its frame through sqlInt, the null order explicit, every rank a DOUBLE`, w.ok && w.sql.includes('ORDER BY t0.c1 DESC NULLS LAST ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)') && w.sql.includes(dialects.dialectFor(d).toDouble('rank() OVER (ORDER BY t0.c2 ASC NULLS LAST)')), w.ok ? w.sql : w.message);
    const corr = await compileSql('SELECT region FROM orders o WHERE EXISTS (SELECT 1 FROM targets t WHERE t.region = o.region)', d);
    const lag = await compileSql('SELECT lag(amount) OVER (ORDER BY order_date) AS p FROM orders', d);
    if (d === 'clickhouse') {
      ok('ClickHouse: a correlated subquery and lag() are refused (pins for the nightly, F7), each in its sentence', !corr.ok && corr.code === 'dialect' && !lag.ok && lag.code === 'dialect' && /ClickHouse/.test(lag.message));
    } else {
      ok(`golden ${d}: a correlated EXISTS reads the outer alias t0, and lag() prints`, corr.ok && corr.sql.includes('(t1.c0 = t0.c0)') && lag.ok && lag.sql.includes('lag(t0.c1) OVER (ORDER BY t0.c0 ASC NULLS LAST)'), `${corr.ok ? corr.sql : corr.message}\n${lag.ok ? lag.sql : lag.message}`);
    }
  }
  const lim = await compileSql('SELECT region FROM orders LIMIT 900', 'duckdb');
  const small = await compileSql('SELECT region FROM orders LIMIT 3', 'duckdb');
  ok('F-D8: LIMIT 501 caps a larger LIMIT; a smaller one stands; every output is appended to the order', lim.ok && lim.sql.endsWith('ORDER BY o_0 ASC NULLS LAST LIMIT 501') && small.ok && small.sql.endsWith('LIMIT 3'));
  const using = await compileSql('SELECT region, t.target FROM orders o FULL JOIN targets t USING (region)', 'redshift');
  ok('USING is written out as ON; the merged key is COALESCE(left, right) after a FULL join', using.ok && !/USING/.test(using.sql) && using.sql.includes('FULL JOIN v1 AS t1 ON (t0.c0 = t1.c0)') && using.sql.includes('COALESCE(t0.c0, t1.c0)'), using.ok ? using.sql : '');
  const self = await compileSql('SELECT a.region FROM orders a JOIN orders b ON a.amount < b.amount', 'duckdb');
  ok('a self join reads ONE view twice, under two generated aliases', self.ok && (self.sql.match(/^WITH v0 AS|\nv1 AS/gm) ?? []).length === 1 && self.sql.includes('v0 AS t0 INNER JOIN v0 AS t1'));
  const today = await compileSql('SELECT count(*) AS n FROM orders WHERE order_date < current_date', 'snowflake');
  ok('current_date binds the given day as a DATE parameter (F-D4)', today.ok && !/current_date/i.test(today.sql) && today.params.some((p) => p.type === 'date' && p.value === '2026-11-15'));
  const div = await compileSql('SELECT count(*) / 2 AS half FROM orders', 'redshift');
  ok('F-D5: a count is a DOUBLE before it divides, and divides by NULLIF(r, 0)', div.ok && /\(CAST\(count\(\*\) AS DOUBLE PRECISION\) \/ NULLIF\(CAST\(\$\d AS DOUBLE PRECISION\), 0\)\)/.test(div.sql), div.ok ? div.sql : '');
}

/** The text of `make(v)` for each value: identical to the sentinel's, with v in the parameters. */
async function literalLeaks(d: CompileDialectId | SqlDialect, make: (lit: string) => string): Promise<{ leaks: string[]; refused: number }> {
  const lit = (v: string): string => `'${v.replace(/'/g, "''")}'`;
  const base = await compileSql(make(lit('SENTINEL_VALUE')), d);
  if (!base.ok) return { leaks: [`the sentinel statement is refused: ${base.message}`], refused: 0 };
  const leaks: string[] = [];
  let refused = 0;
  // A LIKE pattern travels with the dialect's escape character doubled (print.ts), so look for either spelling.
  const esc = dialects.dialectFor(d).likeEscape;
  for (const v of corpus.LITERALS) {
    const p = await compileSql(make(lit(v)), d);
    // DuckDB's parser ends a literal at a NUL: refused at the front door, never bound or printed.
    if (!p.ok) { if (p.code === 'parse' && v.includes('\u0000')) refused += 1; else leaks.push(`${JSON.stringify(v)} refused: ${p.code}`); continue; }
    if (p.sql !== base.sql) leaks.push(`${JSON.stringify(v)} changed the text`);
    else if (!p.params.some((x) => typeof x.value === 'string' && (x.value.includes(v) || x.value.includes(v.split(esc).join(esc + esc))))) leaks.push(`${JSON.stringify(v)} is not among the parameters`);
  }
  return { leaks, refused };
}

const LITERAL_FORMS = [
  (l: string): string => `SELECT region FROM orders WHERE region = ${l}`,
  (l: string): string => `SELECT region FROM orders WHERE note IN (${l}, 'x') OR region < ${l}`,
  (l: string): string => `SELECT count(*) AS n FROM orders WHERE note LIKE ${l} OR note NOT LIKE ${l}`,
  (l: string): string => `SELECT ${l} AS x, coalesce(note, ${l}) AS y, CASE WHEN region = ${l} THEN ${l} END AS z FROM orders`,
  (l: string): string => `SELECT region FROM orders WHERE note BETWEEN ${l} AND ${l} GROUP BY region HAVING max(note) <> ${l}`,
  (l: string): string => `WITH s AS (SELECT region FROM orders WHERE note = ${l}) SELECT region FROM s WHERE region IN (SELECT region FROM targets WHERE note = ${l})`,
];

async function adversarial(): Promise<void> {
  for (const d of ALL) {
    let leaks: string[] = [];
    let refused = 0;
    for (const form of LITERAL_FORMS) {
      const r = await literalLeaks(d, form);
      leaks = leaks.concat(r.leaks);
      refused += r.refused;
    }
    const nul = corpus.LITERALS.filter((v) => v.includes('\u0000')).length * LITERAL_FORMS.length;
    ok(`adversarial literals on ${d}: ${corpus.LITERALS.length} values × ${LITERAL_FORMS.length} forms — the text never moves, each value is a parameter (a NUL: refused by the parser)`, leaks.length === 0 && refused === nul, `${refused}/${nul} ${leaks.slice(0, 5).join(' | ')}`);
  }
  // NEGATIVE CONTROL: a printer that inlines one literal (the dialect's placeholder spliced with the value).
  const inline: SqlDialect = { ...dialects.dialectFor('duckdb'), placeholder: (_i, p) => `'${String(p.value).replace(/'/g, "''")}'` };
  const caught = await literalLeaks(inline, LITERAL_FORMS[0]);
  ok('NEGATIVE CONTROL: a printer that inlines a literal is caught by the same suite', caught.leaks.length >= corpus.LITERALS.length - 2, caught.leaks.length);

  // The model's names never reach the text: aliases, quoting, comments and case change nothing printed.
  for (const d of ALL) {
    const plain = await compileSql('SELECT o.region AS r, sum(o.amount) AS s FROM orders o GROUP BY o.region ORDER BY r', d);
    const hostile = await compileSql('SELECT "X""; DROP TABLE orders; --".region AS "evil""alias", sum("X""; DROP TABLE orders; --"."Amount") /* ; DROP */ AS `s` FROM ORDERS AS "X""; DROP TABLE orders; --" -- tail\nGROUP BY 1 ORDER BY "evil""alias"', d);
    const quoted = await compileSql('SELECT "o".region AS r, sum("o"."amount") AS s FROM "orders" o GROUP BY o.region ORDER BY r', d);
    ok(`identifiers on ${d}: a quoted name is a column (never a string), and quoting changes nothing printed`, plain.ok && quoted.ok && quoted.sql === plain.sql);
    ok(`identifiers on ${d}: a hostile alias, comment or table name is refused or absent — never text`, !hostile.ok || !/DROP|evil/.test(hostile.sql));
    const renamed = await compileSql('SELECT "X""; DROP TABLE orders; --".region AS "evil""alias", sum("X""; DROP TABLE orders; --"."Amount") /* ; DROP */ AS s FROM ORDERS AS "X""; DROP TABLE orders; --" -- tail\nGROUP BY "X""; DROP TABLE orders; --".region ORDER BY "evil""alias"', d);
    ok(`identifiers on ${d}: with hostile aliases, a comment and upper case, the statement prints exactly as the plain one`, renamed.ok && plain.ok && renamed.sql === plain.sql, renamed.ok ? renamed.sql : renamed.message);
  }
  // A record's own hostile column names reach the text through ident() alone.
  const names = ['a"b', 'x`y', 'z\\w', '; DROP TABLE t; --', 'é', '東京', ' sp ace'];
  const evil: LiveColumn[] = names.map((name) => ({ name, type: 'text' }));
  const env: SqlEnv = { tables: new Map([['evil', { id: 'e1', columns: evil }]]), today: '2026-11-15' };
  for (const d of ALL) {
    const p = await compileSql('SELECT * FROM evil', d, env, () => ({ env: { source: { kind: 'table', parts: ['s', 'evil'] }, columns: evil }, lock: [] }));
    const dl = dialects.dialectFor(d);
    const stripped = p.ok ? names.reduce((s, n) => s.split(dl.ident(n)).join(''), p.sql) : '';
    ok(`identifiers on ${d}: a record's hostile column names appear only as ident() output`, p.ok && names.every((n) => p.sql.includes(`lv_src.${dl.ident(n)}`)) && !/DROP|東京|é/.test(stripped));
  }
}

async function refusals(): Promise<void> {
  const threats = new Map<string, number>();
  for (const r of corpus.REFUSED) {
    const got = tree.translate(await tree.parseSql(r.sql), CORPUS_ENV);
    const twin = tree.translate(await tree.parseSql(r.twin), CORPUS_ENV);
    const printedTwin = twin.ok ? print.printLiveSql(twin.ir, twin.ir.views.map((v) => ({ env: { source: { kind: 'table' as const, parts: [v.slug] }, columns: [...CORPUS_ENV.tables.get(v.slug)!.columns] }, lock: [] })), 'duckdb') : null;
    ok(`[${r.threat}] refused: ${r.name} (${r.code}), in a sentence; its twin translates and prints`, !got.ok && got.code === r.code && got.message.length > 10 && !/undefined|\[object/.test(got.message) && !!printedTwin?.ok,
      `${got.ok ? 'TRANSLATED' : `${got.code}: ${got.message}`} / twin ${twin.ok ? (printedTwin?.ok ? 'ok' : JSON.stringify(printedTwin)) : `${twin.code}: ${twin.message}`}`);
    threats.set(r.threat, (threats.get(r.threat) ?? 0) + 1);
    if (!r.seam) continue;
    // NEGATIVE CONTROL: widen the one entry that refused it; the refusal must move or go.
    let widened: ReturnType<typeof tree.translate>;
    if (r.seam.kind === 'function') {
      shapes.FUNCTIONS.set(r.seam.name, 'abs');
      try { widened = tree.translate(await tree.parseSql(r.sql), CORPUS_ENV); } finally { shapes.FUNCTIONS.delete(r.seam.name); }
    } else {
      const rules = shapes.SHAPES[r.seam.shape];
      const was = rules[r.seam.key];
      rules[r.seam.key] = 'any';
      try { widened = tree.translate(await tree.parseSql(r.sql), CORPUS_ENV); } finally { rules[r.seam.key] = was; }
    }
    ok(`NEGATIVE CONTROL [${r.threat}] ${r.name}: with its ${r.seam.kind === 'function' ? `function ${r.seam.name}` : `key ${r.seam.shape}.${r.seam.key}`} allowed, it is no longer refused for it`,
      widened.ok || widened.code !== r.code || widened.message !== (got.ok ? '' : got.message), widened.ok ? 'translated' : `${widened.code}: ${widened.message}`);
  }
  ok(`the refusal table: ${corpus.REFUSED.length} constructs (${[...threats].map(([k, v]) => `${k} ${v}`).join(', ')}), ${corpus.REFUSED.filter((r) => r.seam).length} with a widened-guard control`, corpus.REFUSED.length >= 100);
}

/** Every (shape, key) the parser emits under keys the translator reads; refused shapes and defaulted keys stop the walk. */
function census(tree0: unknown, seen: Map<string, number>, unknown: Set<string>): void {
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!shapes.isNode(v)) return;
    const shape = shapes.shapeOf(v);
    if (shapes.REFUSED[shape]) { seen.set(shape, (seen.get(shape) ?? 0) + 1); return; }
    const rules = shapes.SHAPES[shape];
    if (!rules) { unknown.add(shape); return; }
    for (const [k, x] of Object.entries(v)) {
      const id = `${shape}.${k}`;
      seen.set(id, (seen.get(id) ?? 0) + 1);
      if (!rules[k]) unknown.add(id);
      else if (rules[k] === 'read') walk(x);
    }
  };
  walk(tree0);
}

async function keyCensus(): Promise<void> {
  const texts = [
    ...corpus.CASES.map((c) => c.sql), ...corpus.REFUSED.flatMap((r) => [r.sql, r.twin]),
    ...LITERAL_FORMS.map((f) => f("'x'")), golden.A_SQL,
  ];
  const seen = new Map<string, number>();
  const unknown = new Set<string>();
  for (const t of texts) census(await tree.parseSql(t), seen, unknown);
  const shapeCount = new Set([...seen.keys()].map((k) => k.split('.')[0])).size;
  ok(`key census over ${texts.length} statements: ${shapeCount} node shapes, ${seen.size} (shape, key) pairs — every one classified (F-D2)`, unknown.size === 0, [...unknown].join(', '));
  const listed = Object.entries(shapes.SHAPES).flatMap(([s, keys]) => Object.keys(keys).map((k) => `${s}.${k}`));
  const unseen = listed.filter((k) => !seen.has(k) && !k.startsWith('root.'));
  ok(`key census: the corpus reaches ${listed.length - unseen.length} of the ${listed.length} classified keys (each unseen one is a default the parser omits)`, unseen.length < listed.length / 3, unseen.join(', '));

  // CONTROL: a key the translator has not classified, planted in a real tree, is refused and named by the census.
  const planted = await tree.parseSql('SELECT region FROM orders') as { statements: { node: Record<string, unknown> }[] };
  planted.statements[0].node.settings = { max_threads: 1 };
  const r = tree.translate(planted, ENV);
  const flagged = new Set<string>();
  census(planted, new Map(), flagged);
  ok('NEGATIVE CONTROL: an unclassified key planted in a fixture tree is refused, and the census names it', !r.ok && r.code === 'construct' && /settings/.test(r.message) && flagged.has('node:SELECT_NODE.settings'), JSON.stringify(r));
  const nested = await tree.parseSql('SELECT region FROM orders WHERE amount > 1') as { statements: { node: { where_clause: Record<string, unknown> } }[] };
  nested.statements[0].node.where_clause.collation = 'nocase';
  const n2 = tree.translate(nested, ENV);
  ok('NEGATIVE CONTROL: …and so is one planted on an expression deep in the tree', !n2.ok && /collation/.test(n2.message));
  const deep = `SELECT region FROM orders WHERE ${'('.repeat(150)}amount${' + 1)'.repeat(150)} > 0`;
  const d = tree.translate(await tree.parseSql(deep), ENV);
  ok('a statement nested past the depth bound is refused, never walked unbounded', !d.ok && (d.code === 'depth' || d.code === 'parse'), d.ok ? 'translated' : d.code);
}

async function views(): Promise<void> {
  for (const d of ALL) {
    const dl = dialects.dialectFor(d);
    const lockClause = `${dl.binary(`coalesce(${dl.text(`lv_src.${dl.ident('region')}`)}, '')`)} IN (`;
    const hasLock = (sql: string): boolean => sql.split('\n')[0].includes(lockClause);
    const locked = await compileSql('SELECT amount FROM orders', d);
    const open = await compileSql('SELECT amount FROM orders', d, ENV, () => ({ ...INPUT, lock: [] }));
    ok(`view on ${d}: the lock is in the view's WHERE, byte-compared (${dl.binary('x')}), its value bound`, locked.ok && hasLock(locked.sql) && locked.params.some((p) => p.value === 'East'));
    ok(`NEGATIVE CONTROL: view on ${d} built without the lock fails the same lock-clause check`, open.ok && !hasLock(open.sql));
  }
  // The lock may hold a column hidden from the caller: the WHERE applies before the projection.
  const hidden: SqlEnv = { tables: new Map([['orders', { id: 'o1', columns: COLS.filter((c) => c.name !== 'region' && c.name !== 'note') }]]), today: '2026-11-15' };
  const star = await compileSql('SELECT * FROM orders', 'duckdb', hidden);
  ok('hidden columns: SELECT * projects the visible columns only, and the lock still holds on a hidden one', star.ok && star.sql.includes('AS c1 FROM') && !star.sql.includes('AS c2') && !/"note"/.test(star.sql) && star.sql.includes('encode(coalesce(CAST(lv_src."region"'));
  const named = tree.translate(await tree.parseSql('SELECT note FROM orders'), hidden);
  ok('hidden columns: naming one is an unknown column — the translator is never told it exists', !named.ok && named.code === 'column');
  // A lock that cannot apply refuses; it never skips.
  const empty = await compileSql('SELECT amount FROM orders', 'duckdb', ENV, () => ({ ...INPUT, lock: [{ type: 'filter', column: 'region', op: 'in', values: [], lock: true } as FilterStep] }));
  ok('a lock step that would be skipped (an empty list) refuses the statement', !empty.ok, JSON.stringify(empty));
  let reason = '';
  try {
    await compileSql('SELECT amount FROM orders', 'duckdb', ENV, () => ({ ...INPUT, lock: [{ type: 'filter', column: 'gone', op: 'in', values: ['x'], lock: true } as FilterStep] }));
  } catch (e) {
    reason = (e as { reason?: string }).reason ?? String(e);
  }
  ok("a lock on a column the record no longer has throws the row gate's typed refusal ('column')", reason === 'column', reason);
  // A calc is computed only when read, in its own layer, the base filters innermost.
  const calcs = [{ name: 'Margin', expression: '[amount] * 2', type: 'number' as const }];
  const withCalc: SqlEnv = { tables: new Map([['orders', { id: 'o1', columns: [...COLS, { name: 'Margin', type: 'number' }] }]]), today: '2026-11-15' };
  const calcInput = (): ViewInput => ({ env: { ...INPUT.env, source: { kind: 'table', parts: ['ANALYTICS', 'ORDERS'], calcs }, columns: [...COLS, { name: 'Margin', type: 'number' }] }, lock: LOCK });
  const reads = await compileSql('SELECT sum(Margin) AS m FROM orders', 'snowflake', withCalc, calcInput);
  const skips = await compileSql('SELECT sum(amount) AS m FROM orders', 'snowflake', withCalc, calcInput);
  ok('a calc read is computed in its layer under the view (base filters innermost, the lock outside); one not read is never computed',
    reads.ok && reads.sql.includes('AS "Margin" FROM (SELECT') && hasBaseInnermost(reads.sql) && skips.ok && !skips.sql.includes('Margin'), reads.ok ? reads.sql : reads.message);
  const dbx = await compileSql('SELECT sum(Margin) AS m FROM orders', 'databricks', withCalc, calcInput);
  ok("a calc on Databricks is refused in the compiler's own sentence (calcDialect), not printed", !dbx.ok && dbx.code === 'calcDialect');
}

const hasBaseInnermost = (sql: string): boolean => /FROM "ANALYTICS"\."ORDERS" AS lv_src WHERE \(CASE WHEN/.test(sql);

async function main(): Promise<void> {
  await goldenShapes();
  await adversarial();
  await refusals();
  await keyCensus();
  await views();
}

main()
  .catch((e) => ok('live SQL compile suite threw', false, e && (e as Error).stack))
  .finally(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    finish();
  });
