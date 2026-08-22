'use strict';

// Self-check for src/parquetStore.ts — the Phase 2 storage primitive.
//
// The whole point of this module is that NOTHING changes on the way to disk and
// back, so most of this file is a fidelity gauntlet: leading zeros, >15-digit
// ids, the three distinct kinds of "empty" (null / '' / '   '), unicode, embedded
// quotes and newlines, and the degenerate 0-row / 0-column shapes. The rest
// covers the operational promises: atomic writes leave no debris, a corrupt file
// returns null instead of throwing, and `relationSql` is really usable as SQL.
//
// Ends with a size/latency report — on-disk size versus the equivalent JSON is a
// real part of what this phase is buying.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as pq from '../src/engine/parquetStore';
import * as duck from '../src/engine/duckdb';
import type { ParsedColumn } from '../src/data/parse';
import type { Cell } from '../src/data/transforms';

import { ok, failureCount } from './selfcheck';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-parquet-'));
let seq = 0;
function tmpFile(): string {
  return path.join(dir, `t${seq++}.parquet`);
}

function cleanup(): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function same(a: Cell[][], b: Cell[][]): boolean {
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    if (a[r].length !== b[r].length) return false;
    for (let c = 0; c < a[r].length; c++) {
      const x = a[r][c];
      const y = b[r][c];
      // Object.is so null vs '' vs 0 can never compare equal by coercion.
      if (!Object.is(x, y)) return false;
    }
  }
  return true;
}

// A whole-table round trip through disk, re-typed with the caller's schema.
function roundTrip(columns: ParsedColumn[], rows: Cell[][]): { columns: ParsedColumn[]; rows: Cell[][] } | null {
  const f = tmpFile();
  pq.writeTable(f, columns, rows);
  return pq.readTable(f, columns);
}

// ── Availability gate ────────────────────────────────────────────────────────

if (!pq.isSupported()) {
  console.error('FAIL parquetStore: DuckDB bridge unavailable — cannot run storage checks');
  cleanup();
  process.exit(1);
}
ok('isSupported(): true when the bridge is up', pq.isSupported() === true);

// ── Fidelity: the values that must survive ───────────────────────────────────

{
  // Every one of these is a value that a naive/typed writer gets wrong.
  const columns: ParsedColumn[] = [
    { name: 'sku', type: 'text' }, // 007 must not become 7
    { name: 'id', type: 'text' }, // >15 digits must not lose precision
    { name: 'note', type: 'text' }, // null / '' / '   ' are three different things
    { name: 'amount', type: 'number' },
    { name: 'when', type: 'date' },
  ];
  const rows: Cell[][] = [
    ['007', '12345678901234567890', null, -3.5, '2024-01-01'],
    ['0123', '9007199254740993', '', 0, '2024/02/29'],
    ['00', '000000000000000001', '   ', 1234.5678, 'Jan 5, 2023'],
    ['7', '1', '\t', -0.000001, ''],
  ];
  const back = roundTrip(columns, rows);
  ok('fidelity: readTable returned a table', back !== null);
  ok('fidelity: leading zeros survive (007, 0123, 00)', back?.rows[0][0] === '007' && back?.rows[1][0] === '0123' && back?.rows[2][0] === '00');
  ok('fidelity: >15-digit id strings are byte-exact', back?.rows[0][1] === '12345678901234567890' && back?.rows[1][1] === '9007199254740993');
  ok('fidelity: null stays null', back?.rows[0][2] === null);
  ok("fidelity: '' stays '' (NOT null — the ingest rule must not leak in)", back?.rows[1][2] === '');
  ok("fidelity: '   ' stays '   ' (whitespace not trimmed)", back?.rows[2][2] === '   ');
  ok('fidelity: three empties stay mutually distinct', back?.rows[0][2] !== back?.rows[1][2] && back?.rows[1][2] !== back?.rows[2][2]);
  ok('fidelity: negative + float numbers come back as JS numbers', back?.rows[0][3] === -3.5 && back?.rows[2][3] === 1234.5678 && back?.rows[3][3] === -0.000001);
  ok('fidelity: zero stays the number 0, not null or ""', Object.is(back?.rows[1][3], 0));
  ok('fidelity: date column kept verbatim as text', back?.rows[2][4] === 'Jan 5, 2023' && back?.rows[3][4] === '');
  ok('fidelity: full deep equality', back !== null && same(back.rows, rows));
  ok('fidelity: column metadata echoed back from the caller schema', JSON.stringify(back?.columns) === JSON.stringify(columns));
}

// ── Fidelity: unicode + text that breaks naive delimited formats ─────────────

{
  const columns: ParsedColumn[] = [{ name: 'txt', type: 'text' }];
  // Every one of these is a shape that breaks a naive CSV/TSV round trip.
  const rows: Cell[][] = [
    ['emoji \u{1F600}\u{1F1EF}\u{1F1F5} done'],
    ['nbsp[\u00A0]'], // NBSP: DuckDB's trim() strips it, RE2's \\s does not (06 §1)
    ['He said "hi", then "bye"'],
    ['line1\nline2\r\nline3'],
    ['a,b,c\ttabbed'],
    ['{"json":"looking"}'],
    ['back\\slash and \u0001 control'],
    ['ünïcödé ß 中文 עברית'],
    ['\uFEFFBOM-led'],
  ];
  const back = roundTrip(columns, rows);
  ok('unicode: emoji (incl. ZWJ/flag pairs) survive', back?.rows[0][0] === rows[0][0]);
  ok('unicode: NBSP survives (not collapsed to a space)', back?.rows[1][0] === rows[1][0]);
  ok('text: embedded double quotes survive', back?.rows[2][0] === rows[2][0]);
  ok('text: embedded LF and CRLF survive', back?.rows[3][0] === rows[3][0]);
  ok('text: embedded commas and tabs survive', back?.rows[4][0] === rows[4][0]);
  ok('text: JSON-looking text is not re-parsed', back?.rows[5][0] === rows[5][0]);
  ok('text: backslash and control chars survive', back?.rows[6][0] === rows[6][0]);
  ok('text: non-latin scripts survive', back?.rows[7][0] === rows[7][0]);
  ok('text: leading BOM survives (duckdb.ts transport eats one — see bomSafe)', back?.rows[8][0] === rows[8][0]);
  ok('unicode: full deep equality', back !== null && same(back.rows, rows));

  // Pin the workaround: the Parquet file itself was always faithful, so the
  // repair must be a no-op on every value that does NOT start with a BOM.
  const f = tmpFile();
  const bomRows: Cell[][] = [['\uFEFF'], ['\uFEFF\uFEFFtwo'], ['mid\uFEFFdle'], ['trailing\uFEFF'], ['plain'], [null], ['']];
  pq.writeTable(f, columns, bomRows);
  const lens = duck.query(`SELECT length("c0") AS n FROM ${pq.relationSql(f)};`).map((r) => Number(r.n ?? -1));
  ok('BOM: the stored Parquet value was never truncated', lens[0] === 1 && lens[1] === 5 && lens[3] === 9);
  ok('BOM: every leading-BOM shape round-trips', same(pq.readTable(f, columns)?.rows ?? [], bomRows));
}

// ── The one value class JSON cannot carry: unpaired surrogates ──────────────

{
  // An unpaired UTF-16 surrogate is not representable in JSON, so the NDJSON
  // ingest rejects it. writeTable must still SUCCEED (sanitising to U+FFFD)
  // rather than fail the save — this is the documented lossy case.
  const columns: ParsedColumn[] = [{ name: 'txt', type: 'text' }];
  const rows: Cell[][] = [['a\uD800b'], ['\uDC00'], ['ok'], ['pair \u{1F600} kept'], [null]];
  let threw = false;
  let back: { rows: Cell[][] } | null = null;
  try {
    back = roundTrip(columns, rows);
  } catch {
    threw = true;
  }
  ok('surrogate: writeTable does not fail the save', !threw && back !== null);
  ok('surrogate: KNOWN LOSS — a lone surrogate becomes U+FFFD', back?.rows[0][0] === 'a�b' && back?.rows[1][0] === '�');
  ok('surrogate: well-formed neighbours in the same table are untouched', back?.rows[2][0] === 'ok' && back?.rows[3][0] === 'pair \u{1F600} kept');
  ok('surrogate: nulls survive the sanitising rewrite', back?.rows[4][0] === null);
}

// ── Number-column edge cases (documented lossy corners) ─────────────────────

{
  const columns: ParsedColumn[] = [{ name: 'n', type: 'number' }];
  const rows: Cell[][] = [[1e21], [1e-7], [Number.MAX_SAFE_INTEGER], [0.1 + 0.2], [null]];
  const back = roundTrip(columns, rows);
  ok('number: exponential magnitudes round-trip', back?.rows[0][0] === 1e21 && back?.rows[1][0] === 1e-7);
  ok('number: MAX_SAFE_INTEGER exact', back?.rows[2][0] === Number.MAX_SAFE_INTEGER);
  ok('number: float bit pattern preserved (0.1+0.2)', back?.rows[3][0] === 0.30000000000000004);
  ok('number: null stays null', back?.rows[4][0] === null);
}

{
  // A `number` column whose stored text is not a number — the documented
  // "NaN-producing value" case. It must become null, never NaN and never a
  // wrong number (parse.coerceCell makes the same choice).
  const back = roundTrip([{ name: 'n', type: 'number' }], [['abc'], [NaN], [Infinity], [-Infinity], ['12']]);
  ok('number: non-numeric text in a number column → null (never NaN)', back?.rows[0][0] === null);
  ok('number: a NaN cell → null', back?.rows[1][0] === null);
  ok('number: Infinity / -Infinity → null', back?.rows[2][0] === null && back?.rows[3][0] === null);
  ok('number: numeric text in a number column → JS number', back?.rows[4][0] === 12);
}

{
  // The one number that does NOT round-trip, asserted so it stays documented.
  const back = roundTrip([{ name: 'n', type: 'number' }], [[-0]]);
  ok('number: KNOWN GAP — -0 comes back as +0 (String(-0) === "0")', Object.is(back?.rows[0][0], 0));
}

// ── The positional-name contract ─────────────────────────────────────────────

{
  // User headers that no Parquet schema should be asked to carry.
  const columns: ParsedColumn[] = [
    { name: '', type: 'text' },
    { name: 'a', type: 'text' },
    { name: 'a', type: 'number' }, // duplicate name
    { name: 'Name "X"', type: 'text' },
    { name: 'has\nnewline', type: 'text' },
    { name: 'sel"ect; DROP', type: 'text' },
  ];
  const rows: Cell[][] = [['p', 'q', 1, 'r', 's', 't'], [null, '', 2, '  ', '\n', '"']];
  const f = tmpFile();
  pq.writeTable(f, columns, rows);

  const raw = pq.readTable(f);
  ok('naming: without a schema, columns are positional c0..cN', raw?.columns.map((c) => c.name).join(',') === 'c0,c1,c2,c3,c4,c5');
  ok("naming: without a schema, every column is typed 'text'", raw?.columns.every((c) => c.type === 'text') === true);
  ok('naming: without a schema, cells are the raw storage strings', raw?.rows[0][2] === '1' && raw?.rows[1][2] === '2');
  ok('naming: raw view keeps null/empty distinct', raw?.rows[1][0] === null && raw?.rows[1][1] === '');

  const back = pq.readTable(f, columns);
  ok('naming: with a schema, hostile/duplicate/empty names round-trip exactly', JSON.stringify(back?.columns) === JSON.stringify(columns));
  ok('naming: with a schema, the duplicate-named number column is re-typed', back?.rows[0][2] === 1 && back?.rows[1][2] === 2);
  ok('naming: with a schema, cells deep-equal the input', back !== null && same(back.rows, rows));

  // A short schema must not silently drop or invent columns.
  const partial = pq.readTable(f, columns.slice(0, 2));
  ok('naming: a short schema keeps the file width, falling back to c<i>', partial?.columns.map((c) => c.name).join(',') === ',a,c2,c3,c4,c5');
}

// ── Degenerate shapes ────────────────────────────────────────────────────────

{
  const columns: ParsedColumn[] = [
    { name: 'a', type: 'text' },
    { name: 'b', type: 'number' },
  ];
  const back = roundTrip(columns, []);
  ok('empty: 0 rows round-trips', back !== null && back.rows.length === 0);
  ok('empty: columns are preserved through a 0-row table', JSON.stringify(back?.columns) === JSON.stringify(columns));
}

{
  const f = tmpFile();
  pq.writeTable(f, [], []);
  const back = pq.readTable(f);
  ok('0-col: 0 columns / 0 rows round-trips', back !== null && back.columns.length === 0 && back.rows.length === 0);
}

{
  const f = tmpFile();
  const rows: Cell[][] = [[], [], []];
  pq.writeTable(f, [], rows);
  const back = pq.readTable(f);
  ok('0-col: 0 columns but 3 rows keeps the row count', back?.columns.length === 0 && back?.rows.length === 3);
  ok('0-col: each row is an empty array', back !== null && same(back.rows, rows));
}

{
  // Ragged input must not desynchronise the file from the record.
  const columns: ParsedColumn[] = [
    { name: 'a', type: 'text' },
    { name: 'b', type: 'text' },
    { name: 'c', type: 'text' },
  ];
  const back = roundTrip(columns, [['x'], ['x', 'y', 'z', 'EXTRA'], []] as Cell[][]);
  ok('ragged: every row is padded/truncated to the column count', back?.rows.every((r) => r.length === 3) === true);
  ok('ragged: missing cells become null, extras are dropped', back?.rows[0][1] === null && back?.rows[1][2] === 'z');
}

// ── Atomic write ─────────────────────────────────────────────────────────────

{
  const f = path.join(dir, 'atomic.parquet');
  pq.writeTable(f, [{ name: 'a', type: 'text' }], [['first']]);
  const after1 = fs.readdirSync(dir).filter((n) => n.startsWith('atomic.'));
  ok('atomic: exactly one file exists after a write', after1.length === 1 && after1[0] === 'atomic.parquet');
  ok('atomic: no .tmp / .ndjson.tmp debris left behind', fs.readdirSync(dir).every((n) => !n.endsWith('.tmp')));

  // Overwrite in place — the rename must replace, not fail or duplicate.
  pq.writeTable(f, [{ name: 'a', type: 'text' }], [['second'], ['third']]);
  const back = pq.readTable(f);
  ok('atomic: overwrite replaces the previous content', back?.rows.length === 2 && back?.rows[0][0] === 'second');
  ok('atomic: still exactly one file after an overwrite', fs.readdirSync(dir).filter((n) => n.startsWith('atomic.')).length === 1);
}

{
  // A failing write must not publish a partial file NOR leave debris.
  const f = path.join(dir, 'nosuchdir', 'x.parquet');
  let threw = false;
  try {
    pq.writeTable(f, [{ name: 'a', type: 'text' }], [['v']]);
  } catch {
    threw = true;
  }
  ok('atomic: a write into a missing directory throws', threw);
  ok('atomic: the target file was never created', !fs.existsSync(f));
  ok('atomic: no debris in the parent directory', fs.readdirSync(dir).every((n) => !n.endsWith('.tmp')));
}

// ── Never throw on a bad file ────────────────────────────────────────────────

{
  const missing = path.join(dir, 'does-not-exist.parquet');
  ok('robust: a missing file returns null', pq.readTable(missing) === null);

  const garbage = path.join(dir, 'garbage.parquet');
  fs.writeFileSync(garbage, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02]));
  ok('robust: garbage bytes return null', pq.readTable(garbage) === null);

  const empty = path.join(dir, 'zero-bytes.parquet');
  fs.writeFileSync(empty, '');
  ok('robust: a zero-byte file returns null', pq.readTable(empty) === null);

  // A real Parquet file truncated mid-way — the realistic "crash during write"
  // shape that the atomic rename is meant to prevent.
  const good = tmpFile();
  pq.writeTable(good, [{ name: 'a', type: 'text' }], [['x'], ['y']]);
  const truncated = path.join(dir, 'truncated.parquet');
  const bytes = fs.readFileSync(good);
  fs.writeFileSync(truncated, bytes.subarray(0, Math.max(1, bytes.length - 32)));
  ok('robust: a truncated Parquet file returns null', pq.readTable(truncated) === null);

  ok('robust: the bridge is still usable after those failureCount()', pq.readTable(good) !== null);
}

// ── Path safety ──────────────────────────────────────────────────────────────

{
  function throws(fn: () => unknown): boolean {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  }
  ok('path: writeTable rejects a non-.parquet path', throws(() => pq.writeTable(path.join(dir, 'x.json'), [], [])));
  ok('path: writeTable rejects a null byte', throws(() => pq.writeTable(path.join(dir, 'x\u0000.parquet'), [], [])));
  ok('path: writeTable rejects an empty path', throws(() => pq.writeTable('', [], [])));
  ok('path: relationSql rejects a non-.parquet path', throws(() => pq.relationSql(path.join(dir, 'x.csv'))));
  ok('path: relationSql rejects a null byte', throws(() => pq.relationSql('/a\u0000/b.parquet')));
  ok('path: readTable returns null (never throws) for a bad path', pq.readTable(path.join(dir, 'x.json')) === null && pq.readTable('\u0000.parquet') === null);

  // A single quote in a directory name must not break out of the SQL literal.
  const oddDir = path.join(dir, "it's a dir");
  fs.mkdirSync(oddDir, { recursive: true });
  const odd = path.join(oddDir, "o'brien.parquet");
  pq.writeTable(odd, [{ name: 'a', type: 'text' }], [['quoted path']]);
  ok("path: a single quote in the path is escaped, not injected", pq.readTable(odd)?.rows[0][0] === 'quoted path');
  ok('path: relationSql doubles the quote', pq.relationSql(odd).includes("it''s a dir"));
}

// ── relationSql is real, usable SQL ──────────────────────────────────────────

{
  const f = tmpFile();
  const rows: Cell[][] = [];
  for (let i = 0; i < 25; i++) rows.push([`n${i}`, i]);
  pq.writeTable(f, [{ name: 'name', type: 'text' }, { name: 'v', type: 'number' }], rows);

  const rel = pq.relationSql(f);
  ok('relationSql: is a read_parquet expression', /^read_parquet\('.*\.parquet'\)$/.test(rel));

  const counted = duck.query(`SELECT count(*) AS n FROM ${rel};`);
  ok('relationSql: SELECT count(*) through it returns the row count', Number(counted[0].n) === 25);

  const projected = duck.query(`SELECT "c0" AS a FROM ${rel} WHERE "c1" = '7';`);
  ok('relationSql: filtering on a positional column works', projected.length === 1 && projected[0].a === 'n7');

  const typed = duck.query(`DESCRIBE SELECT * FROM ${rel};`);
  ok('relationSql: every stored column is VARCHAR', typed.length === 2 && typed.every((r) => r.column_type === 'VARCHAR'));

  const agg = duck.query(`SELECT sum(CAST("c1" AS DOUBLE)) AS s FROM ${rel};`);
  ok('relationSql: casting at point of use aggregates correctly', Number(agg[0].s) === 300);
}

// ── Scale: latency + on-disk size versus JSON ────────────────────────────────

function synth(n: number): { columns: ParsedColumn[]; rows: Cell[][] } {
  const columns: ParsedColumn[] = [
    { name: 'order_id', type: 'text' },
    { name: 'customer', type: 'text' },
    { name: 'region', type: 'text' },
    { name: 'amount', type: 'number' },
    { name: 'qty', type: 'number' },
    { name: 'ordered_at', type: 'date' },
    { name: 'note', type: 'text' },
  ];
  const regions = ['North', 'South', 'East', 'West', 'Central'];
  const rows: Cell[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    rows[i] = [
      String(1000000 + i).padStart(9, '0'),
      `Customer ${i % 5000}`,
      regions[i % regions.length],
      Math.round((i % 977) * 13.37 * 100) / 100,
      (i % 17) + 1,
      `2024-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      i % 9 === 0 ? null : i % 9 === 1 ? '' : `note for row ${i}`,
    ];
  }
  return { columns, rows };
}

console.log('\n── scale (7 columns; times in ms, sizes in KB) ─────────────────');
console.log('rows      write    read   parquet     json   ratio');
for (const n of [10_000, 100_000]) {
  const { columns, rows } = synth(n);
  const f = path.join(dir, `scale-${n}.parquet`);

  let t0 = Date.now();
  pq.writeTable(f, columns, rows);
  const wrote = Date.now() - t0;

  t0 = Date.now();
  const back = pq.readTable(f, columns);
  const read = Date.now() - t0;

  const jsonFile = path.join(dir, `scale-${n}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify({ columns, rows }), 'utf8');

  const pqKb = fs.statSync(f).size / 1024;
  const jsKb = fs.statSync(jsonFile).size / 1024;
  console.log(
    String(n).padEnd(9) +
      String(wrote).padStart(5) +
      String(read).padStart(8) +
      pqKb.toFixed(0).padStart(10) +
      jsKb.toFixed(0).padStart(9) +
      ('  ' + (jsKb / pqKb).toFixed(1) + 'x').padStart(8),
  );

  ok(`scale ${n}: every row came back`, back?.rows.length === n);
  ok(`scale ${n}: deep-equal at scale`, back !== null && same(back.rows, rows));
  ok(`scale ${n}: parquet is smaller than the JSON it replaces`, pqKb < jsKb);
}

// ── Done ─────────────────────────────────────────────────────────────────────

duck.shutdown();
cleanup();

console.log('');
if (failureCount()) {
  console.error(failureCount() + ' parquetStore check(s) FAILED');
  process.exit(1);
}
console.log('All parquetStore checks passed.');
