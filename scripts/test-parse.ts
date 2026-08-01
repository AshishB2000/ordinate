// Self-check for src/parse.ts — RFC-4180 CSV, JSON, paste auto-detect, and
// column type detection. Pure logic (parse.ts imports no Electron), so we just
// require the compiled sibling and assert against real return values. No framework.

export {}; // module scope — sibling test scripts share top-level names

const parse: typeof import('../src/parse') = require('../src/parse');

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else {
    console.error('FAIL ' + label);
    failures++;
  }
}

// ── RFC-4180 CSV: quoted commas, "" escapes, embedded newline ────────────────
{
  const csv = 'name,note\n"Smith, John","line1\nline2"\n"Jane","She said ""hi"""';
  const r = parse.parseCsv(csv);
  ok('csv: two data rows', r.rowCount === 2);
  ok('csv: column names', r.columns.map((c) => c.name).join(',') === 'name,note');
  ok('csv: quoted embedded comma kept in one field', r.rows[0][0] === 'Smith, John');
  ok('csv: quoted embedded newline kept in one field', r.rows[0][1] === 'line1\nline2');
  ok('csv: "" unescaped to a single quote', r.rows[1][1] === 'She said "hi"');
  ok('csv: no ragged/other warnings', r.warnings.length === 0);
}

// ── CRLF line endings + numeric coercion ─────────────────────────────────────
{
  const csv = 'a,b\r\n1,2\r\n3,4\r\n';
  const r = parse.parseCsv(csv);
  ok('crlf: two rows, no trailing empty row', r.rowCount === 2);
  ok('crlf: numeric column typed number', r.columns[0].type === 'number' && r.columns[1].type === 'number');
  ok('crlf: numeric cells coerced to JS numbers', r.rows[0][0] === 1 && r.rows[1][1] === 4);
  ok('crlf: no warnings', r.warnings.length === 0);
}

// ── Ragged rows → warning (pad short, truncate long) ─────────────────────────
{
  const csv = 'a,b,c\n1,2\n3,4,5,6';
  const r = parse.parseCsv(csv);
  ok('ragged: padded/truncated to header width', r.rows.every((row) => row.length === 3));
  ok('ragged: short row padded with null', r.rows[0][2] === null);
  ok('ragged: long row truncated', r.rows[1].length === 3 && r.rows[1][2] === 5);
  ok('ragged: warning emitted', r.warnings.some((w) => w.startsWith('Ragged rows')));
}

// ── Empty input → warning ────────────────────────────────────────────────────
{
  const r = parse.parseCsv('');
  ok('empty csv: no columns', r.columns.length === 0);
  ok('empty csv: rowCount 0', r.rowCount === 0);
  ok('empty csv: "Empty file" warning', r.warnings.includes('Empty file'));

  const rw = parse.parseCsv('   \n  ');
  ok('whitespace-only csv: "Empty file" warning', rw.warnings.includes('Empty file'));
}

// ── JSON array-of-objects (union of keys, missing → null) ────────────────────
{
  const r = parse.parseJson('[{"a":1,"b":2},{"a":3}]');
  ok('json objs: two rows', r.rowCount === 2);
  ok('json objs: union of keys as columns', r.columns.map((c) => c.name).join(',') === 'a,b');
  ok('json objs: numbers coerced', r.rows[0][0] === 1 && r.rows[0][1] === 2);
  ok('json objs: missing key → null', r.rows[1][1] === null);

  // key order = first-seen order across the union.
  const r2 = parse.parseJson('[{"a":1},{"b":2,"a":3}]');
  ok('json objs: union preserves first-seen key order', r2.columns.map((c) => c.name).join(',') === 'a,b');

  // a bare object → single-row array-of-objects.
  const r3 = parse.parseJson('{"x":"foo","y":"bar"}');
  ok('json bare object → one row', r3.rowCount === 1 && r3.rows[0][0] === 'foo');
}

// ── 2D-array JSON (header row vs synthesized names) ──────────────────────────
{
  const r = parse.parseJson('[["x","y"],[1,2],[3,4]]');
  ok('json 2d: header row detected', r.columns.map((c) => c.name).join(',') === 'x,y');
  ok('json 2d: two data rows', r.rowCount === 2);
  ok('json 2d: numbers coerced', r.rows[1][0] === 3 && r.rows[1][1] === 4);

  const r2 = parse.parseJson('[[1,2],[3,4]]');
  ok('json 2d no header: synthesized names', r2.columns.map((c) => c.name).join(',') === 'col1,col2');
  ok('json 2d no header: all rows kept', r2.rowCount === 2);
  ok('json 2d no header: warning emitted', r2.warnings.some((w) => w.startsWith('No header row')));

  const bad = parse.parseJson('{not valid json');
  ok('json invalid: parse warning', bad.warnings.includes('Could not parse as JSON or delimited text'));

  // Headerless 2D array with many rows: column-width detection must use a loop,
  // not Math.max(0, ...arr.map(...)) — arg-spread over ~65k+ elements throws
  // RangeError and would fail an otherwise-valid import instead of trimming rows.
  const wide = '[' + Array.from({ length: 70_000 }, () => '[1,2]').join(',') + ']';
  const rWide = parse.parseJson(wide);
  ok('json 2d no header: large row count does not throw (loop width)', rWide.columns.length === 2);
  // DELIBERATE CHANGE (2026-08): MAX_ROWS went 50,000 -> 1,000,000, so 70,000
  // rows are now UNDER the cap and must all survive. This assertion previously
  // read `=== 50_000`; it was pinning the cap, but what this block actually
  // guards is the loop-vs-arg-spread width detection above. The cap itself is
  // tested in its own block below, against the new number.
  ok('json 2d no header: 70k rows are now under the cap and all kept', rWide.rowCount === 70_000);
}

// ── Paste auto-detect: JSON vs CSV vs TSV ────────────────────────────────────
{
  const j = parse.parsePaste('[{"a":1,"b":2}]');
  ok('paste: JSON detected', j.columns.map((c) => c.name).join(',') === 'a,b' && j.rows[0][0] === 1);

  const t = parse.parsePaste('a\tb\tc\n1\t2\t3\n4\t5\t6');
  ok('paste: TSV detected (3 tab cols)', t.columns.length === 3);
  ok('paste: TSV rows parsed', t.rowCount === 2 && t.rows[1][2] === 6);

  const c = parse.parsePaste('a,b\n1,2\n3,4');
  ok('paste: CSV detected (2 comma cols)', c.columns.length === 2 && c.rowCount === 2);

  // a bare non-tabular JSON scalar is NOT treated as JSON — falls through to
  // CSV (single header cell "42", zero data rows), NOT the JSON path (which
  // would yield 0 columns + "No rows found").
  const scalar = parse.parsePaste('42');
  ok('paste: bare number falls through to delimited', scalar.columns.length === 1 && scalar.rowCount === 0);

  // multi-line digits are invalid JSON → CSV fall-through with real rows.
  const digits = parse.parsePaste('5\n6\n7');
  ok('paste: multi-line digits parse as CSV', digits.columns.length === 1 && digits.rowCount === 2 && digits.rows[0][0] === 6);
}

// ── Column type detection ────────────────────────────────────────────────────
{
  ok('type: all-numeric → number', parse.detectColumnType(['1', '2', '3.5', '-4']) === 'number');
  ok('type: ISO dates → date', parse.detectColumnType(['2024-01-01', '2023/12/31']) === 'date');
  ok('type: mixed date formats → date', parse.detectColumnType(['2024-01-01', '01/15/2024']) === 'date');
  ok('type: mixed number+text → text', parse.detectColumnType(['1', 'apple', '2']) === 'text');
  ok('type: numeric col with empties → number', parse.detectColumnType(['1', '', '3']) === 'number');
  ok('type: all-empty → text', parse.detectColumnType(['', '', '']) === 'text');
  ok('type: bare integer year → number (not date)', parse.detectColumnType(['2024', '2025']) === 'number');
  ok('type: date col with empties → date', parse.detectColumnType(['2024-01-01', '', '2024-02-02']) === 'date');
  // Identifier preservation: never corrupt leading-zero / high-precision ids to numbers.
  ok('type: leading-zero ids → text (007 must stay 007)', parse.detectColumnType(['007', '012', '049']) === 'text');
  ok('type: 20-digit ids → text (precision-safe)', parse.detectColumnType(['12345678901234567890', '99999999999999999999']) === 'text');
  ok('type: zip codes → text', parse.detectColumnType(['02139', '10001', '90210']) === 'text');
  ok('type: real decimals still → number', parse.detectColumnType(['1.50', '2.25', '3']) === 'number');
  ok('type: leading-zero id round-trips through parse as text', (() => {
    const r = parse.parseCsv('code\n007\n012');
    return r.columns[0].type === 'text' && r.rows[0][0] === '007';
  })());
}

// ── Row cap (anti-freeze) ────────────────────────────────────────────────────
{
  // DELIBERATE CHANGE (2026-08): the cap is now 1,000,000, raised because no
  // consumer materialises a whole table any more — Parquet storage, in-place
  // queries, and a paged Explore grid replaced the JS fold, the full IPC clone
  // and the renderer-side copy. The behaviour under test is unchanged: trim to
  // the cap and warn. Only the number moved.
  const CAP = 1_000_000;
  const header = 'n';
  const bodyLines: string[] = [];
  for (let i = 0; i < CAP + 5; i++) bodyLines.push(String(i));
  const r = parse.parseCsv(header + '\n' + bodyLines.join('\n'));
  ok('cap: rowCount clamped to 1,000,000', r.rowCount === CAP);
  ok('cap: warning emitted', r.warnings.some((w) => w.startsWith('Row cap reached')));
  ok('cap: the warning names the true total, not the capped one',
     r.warnings.some((w) => w.includes(String(CAP + 5))));
}

if (failures) {
  console.error('\n' + failures + ' parse check(s) FAILED');
  process.exit(1);
}
console.log('\nAll parse checks passed.');
