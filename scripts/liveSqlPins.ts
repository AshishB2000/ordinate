// The PINS and NEGATIVE CONTROLS of the Live SQL differential (docs/live-data/01-live-sql.md, F2).
// Helper for scripts/test-liveSqlParity*.ts; not a suite itself.
//
// A divergence between DuckDB's reading of the model's text and Live's is a named pin with a check
// that it still exists, never a loosened comparison:
//
//   P1  date_trunc over a DATE is a TIMESTAMP in DuckDB; Live prints its day (F-D7). Normalised.
//   P2  the DuckDB bridge drops a leading U+FEFF from the reference's strings; Live keeps it.
//   P3  DuckDB divides by zero to ±Infinity (a copy's reply reads it as empty); Postgres raises.
//       Live divides by NULLIF(r, 0): NULL on every engine.
//   P4  CAST of a text that is no number: DuckDB raises, Live's safe cast answers NULL.
//   P5  current_date: DuckDB's is the session's local day; the translator binds the day it is given
//       (the app's UTC day in F3; the reference's own here, so the two compare like with like).
//   R4  −0: Postgres returns it (DuckDB stores none); read as 0, as the chart shaping does.
//
// And the five CONTROLS of the PR plan, each of which must make the differential disagree.

import type { ParityEngine } from './liveParityFixture';
import type { Kit, Sources } from './liveSqlDiff';
import type { SqlDialect } from '../src/engine/live/dialect';

const corpus: typeof import('./liveSqlCorpus') = require('./liveSqlCorpus');
const diff: typeof import('./liveSqlDiff') = require('./liveSqlDiff');
const print: typeof import('../src/engine/live/sql/print') = require('../src/engine/live/sql/print');
const cf: typeof import('../src/engine/live/compileFilter') = require('../src/engine/live/compileFilter');
const dialects: typeof import('../src/engine/live/dialects') = require('../src/engine/live/dialects');
const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');

type Ok = (label: string, cond: boolean, extra?: unknown) => void;

const caseNamed = (name: string): import('./liveSqlCorpus').SqlCase => {
  const c = corpus.CASES.find((x) => x.name === name);
  if (!c) throw new Error(`no corpus case "${name}"`);
  return c;
};

/** Run `body` with one property of `obj` replaced, restoring it whatever happens. */
async function patched<T extends object, K extends keyof T, R>(obj: T, key: K, value: T[K], body: () => Promise<R>): Promise<R> {
  const was = obj[key];
  obj[key] = value;
  try {
    return await body();
  } finally {
    obj[key] = was;
  }
}

export async function controls(kit: Kit, sources: Sources, engine: ParityEngine, ok: Ok): Promise<void> {
  const problems = (name: string, opts: { lock: boolean; liveLock?: [] } = { lock: false }) => diff.problems(kit, caseNamed(name), sources, engine, opts);

  // 1. The lock dropped from the view: the locked reference against an unlocked Live answer.
  let caught = 0;
  for (const c of corpus.CASES) if ((await diff.problems(kit, c, sources, engine, { lock: true, liveLock: [] })).length) caught += 1;
  ok(`NEGATIVE CONTROL: ${engine.name}: with the lock dropped from the view, ${caught} of ${corpus.CASES.length} locked statements disagree`, caught >= corpus.CASES.length / 2);

  // 2. LEFT printed as INNER.
  const inner = await patched(print.JOIN_WORDS, 'left', 'INNER JOIN', () => problems('LEFT JOIN keeps the unmatched'));
  ok(`NEGATIVE CONTROL: ${engine.name}: LEFT printed as INNER disagrees`, inner.length > 0, inner.join(' | '));

  // 3. The '' → NULL fold removed from a text column's reading in the view.
  const unfolded = await patched(cf, 'keyText', ((c, col) => cf.textOf(c, col)) as typeof cf.keyText, () => problems("NULL, '' and blanks in one group"));
  ok(`NEGATIVE CONTROL: ${engine.name}: without the '' → NULL fold, the blank group splits in two`, unfolded.length > 0, unfolded.join(' | '));

  // 4. The null order flipped.
  const d: SqlDialect = dialects.dialectFor(engine.dialect);
  const order = d.nullOrder;
  const flipped = await patched(d, 'nullOrder', ((x: string, desc: boolean, first: boolean) => order(x, desc, !first)) as SqlDialect['nullOrder'],
    async () => [await problems('DESC keeps NULL last, as DuckDB does'), await problems('DISTINCT with NULL first')]);
  ok(`NEGATIVE CONTROL: ${engine.name}: the null order flipped disagrees (DESC, and NULLS FIRST)`, flipped.every((p) => p.length > 0), flipped.flat().join(' | '));

  // 5. Integer division: no `toDouble` on a count. Postgres divides two integers as integers; DuckDB never does.
  if (engine.dialect === 'redshift') {
    const c = caseNamed('counts divide as numbers');
    const ref = await diff.reference(kit, c.sql, false);
    const got = await patched(d, 'toDouble', ((x: string) => x) as SqlDialect['toDouble'], () => diff.live(kit, c.sql, sources, [], engine));
    const want = 'error' in ref ? NaN : Number(ref.rows[0][0]);
    const per = 'error' in got ? NaN : Number(got.raw[0][0]);
    ok(`NEGATIVE CONTROL: ${engine.name}: a count divided with no toDouble is integer division (${per}, not ${want})`, Number.isFinite(want) && !Number.isInteger(want) && per === Math.trunc(want), JSON.stringify({ ref, got }));
  }
}

export async function run(kit: Kit, sources: Sources, engine: ParityEngine, ok: Ok): Promise<void> {
  const name = engine.name;

  // P1: DuckDB's date_trunc is a TIMESTAMP; Live's is a DATE printed as its day.
  const months = caseNamed('months');
  const ref = await diff.reference(kit, months.sql, false);
  const got = await diff.live(kit, months.sql, sources, [], engine);
  ok(`PIN P1 (${name}): date_trunc over a DATE is a TIMESTAMP in DuckDB, a day on Live`,
    !('error' in ref) && /^TIMESTAMP/.test(ref.sqlTypes[0]) && !('error' in got) && got.raw.every((r) => typeof r[0] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r[0] as string)), JSON.stringify(ref));

  // P2: the bridge loses the reference's leading BOM; Live's answer keeps it.
  const bomSql = 'SELECT region FROM targets WHERE target = 1';
  const bomRef = await diff.reference(kit, bomSql, false);
  const bomLive = await diff.live(kit, bomSql, sources, [], engine);
  ok(`PIN P2 (${name}): the reference reads 'BOM' (the bridge dropped U+FEFF), Live returns '\\ufeffBOM'`,
    !('error' in bomRef) && bomRef.rows[0]?.[0] === 'BOM' && !('error' in bomLive) && bomLive.raw[0]?.[0] === '﻿BOM', JSON.stringify({ bomRef, bomLive }));

  // P3: DuckDB divides by zero to Infinity; the reference reads it as empty, and so does Live's NULLIF.
  const inf = (await duck.queryAsync('SELECT CAST(1 AS DOUBLE) / 0 AS x'))[0].x;
  const byZero = await diff.live(kit, caseNamed('a division by zero is empty').sql, sources, [], engine);
  ok(`PIN P3 (${name}): DuckDB answers 1/0 as Infinity; Live's NULLIF answers NULL`, String(inf) === 'Infinity' && !('error' in byZero) && byZero.raw.every((r) => r[1] === null));

  // P4: a text that is no number — DuckDB's CAST raises, Live's safe cast is NULL.
  const castSql = "SELECT CAST(cat AS DOUBLE) AS x FROM orders WHERE cat = 'Alpha' LIMIT 1";
  const castRef = await diff.reference(kit, castSql, false);
  const castLive = await diff.live(kit, castSql, sources, [], engine);
  ok(`PIN P4 (${name}): CAST('Alpha' AS DOUBLE) raises in DuckDB, is NULL on Live`, 'error' in castRef && !('error' in castLive) && castLive.raw.length === 1 && castLive.raw[0][0] === null, JSON.stringify({ castRef, castLive }));

  // P5: current_date binds the day the translator was given.
  const cd = await diff.printed(kit, caseNamed('current_date').sql, sources, [], engine.dialect);
  ok(`PIN P5 (${name}): current_date is bound as the given day (${kit.today}), never the warehouse's clock`,
    !('error' in cd) && cd.params.some((p) => p.type === 'date' && p.value === kit.today) && !/current_date/i.test(cd.sql), JSON.stringify(cd));

  // R4: −0 arrives from an engine that stores one, and is read as 0.
  const minus = await diff.live(kit, caseNamed('floor, ceil, abs and minus').sql, sources, [], engine);
  const negZero = 'error' in minus ? -1 : minus.raw.flat().filter((v) => Object.is(v, -0)).length;
  ok(`PIN R4 (${name}): −0 cells from the engine: ${negZero} (Postgres returns them, DuckDB stores none); each read as 0`,
    engine.dialect === 'redshift' ? negZero > 0 : negZero >= 0);
}
