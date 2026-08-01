// Self-check for src/sqlGen.ts — the pure (schema, steps) → DuckDB SQL generator.
// Two halves:
//   1. Structural assertions on the generated SQL string + bound params. sqlGen is
//      a pure function, so plain string matching is the whole contract.
//   2. Execution against the installed `duckdb` CLI over a tiny inline fixture.
//      Generated SQL that does not parse is worthless, and this is the cheapest
//      way to catch it. Skipped (not failed) when the CLI is absent.
//
// KNOWN DIVERGENCES from transforms.ts, asserted here deliberately:
//   - an aggregation over a missing column warns ONCE, not once per group
//     (transforms.ts:365 emits an unbounded duplicate per group).
//   - `contains` / text comparison stringify via DuckDB `CAST(x AS VARCHAR)`;
//     for an aggregate-produced DOUBLE column that formatting may differ from
//     JS `String(n)`.
//   - VARCHAR ordering is byte-wise UTF-8, JS is UTF-16 code-unit.

export {}; // module scope — sibling test scripts share top-level names

const sqlGen: typeof import('../src/sqlGen') = require('../src/sqlGen');
const { execFileSync } = require('child_process') as typeof import('child_process');

type SqlColumn = import('../src/sqlGen').SqlColumn;
type TransformStep = import('../src/transforms').TransformStep;

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else {
    console.error('FAIL ' + label);
    failures++;
  }
}

// city:text, sku:text, units:number, price:number — the test-transforms fixture.
const COLS: SqlColumn[] = [
  { physical: 'c0', name: 'city', type: 'text' },
  { physical: 'c1', name: 'sku', type: 'text' },
  { physical: 'c2', name: 'units', type: 'number' },
  { physical: 'c3', name: 'price', type: 'number' },
];

function gen(steps: TransformStep[], cols: SqlColumn[] = COLS) {
  return sqlGen.generateSql('ds', cols, steps);
}
function sqlOf(steps: TransformStep[], cols: SqlColumn[] = COLS): string {
  const r = gen(steps, cols);
  return r.sql || '';
}
// Count of emitted CTEs (s0 always exists).
function cteCount(sql: string): number {
  return (sql.match(/\bs\d+ AS \(/g) || []).length;
}

// ── Source-only pipeline ─────────────────────────────────────────────────────
{
  const r = gen([]);
  ok('source: one CTE only', cteCount(r.sql || '') === 1);
  ok('source: s0 selects __ord first', (r.sql || '').includes('s0 AS (SELECT __ord, c0, c1, c2, c3 FROM "ds")'));
  ok('source: relation identifier is quoted', (r.sql || '').includes('FROM "ds"'));
  ok('source: outer select strips __ord', (r.sql || '').includes('SELECT c0, c1, c2, c3 FROM s0 ORDER BY __ord'));
  ok('source: ORDER BY __ord appears exactly once', ((r.sql || '').match(/ORDER BY __ord/g) || []).length === 1);
  ok('source: no params, no warnings, no retype', r.params.length === 0 && r.warnings.length === 0 && r.retypeColumns.length === 0);
  ok('source: schema passed through', r.columns.map((c) => c.name).join(',') === 'city,sku,units,price');
}

// ── filter ───────────────────────────────────────────────────────────────────
{
  const r = gen([{ type: 'filter', column: 'units', op: '>', value: 2 }]);
  const s = r.sql || '';
  ok('filter number: TRY_CAST + isfinite guard on the cell', s.includes('CASE WHEN isfinite(TRY_CAST(c2 AS DOUBLE)) THEN TRY_CAST(c2 AS DOUBLE) END > CAST(? AS DOUBLE)'));
  ok('filter number: value is a bound param', r.params.length === 1 && r.params[0] === 2);
  ok('filter number: value never interpolated', !s.includes('> 2'));
  ok('filter: emits a second CTE', cteCount(s) === 2 && s.includes('FROM s1 ORDER BY'));
}
{
  // coerceValue('007','number') is null under the strict gate → no row can match,
  // for EVERY operator including !=.
  const r = gen([{ type: 'filter', column: 'units', op: '!=', value: '007' }]);
  ok('filter number: non-lossless value → WHERE FALSE', (r.sql || '').includes('WHERE FALSE'));
  ok('filter number: WHERE FALSE binds no param', r.params.length === 0);
}
{
  const r = gen([{ type: 'filter', column: 'city', op: '=', value: 'Paris' }]);
  ok('filter text: coalesce so a null cell compares as \'\'', (r.sql || '').includes("coalesce(CAST(c0 AS VARCHAR), '') = CAST(? AS VARCHAR)"));
  ok('filter text: param bound', r.params[0] === 'Paris');
}
{
  const r = gen([{ type: 'filter', column: 'city', op: '!=', value: 'Paris' }]);
  ok('filter text: != maps to SQL <>', (r.sql || '').includes("'') <> CAST(? AS VARCHAR)"));
}
{
  const r = gen([{ type: 'filter', column: 'sku', op: 'contains', value: '01' }]);
  ok('filter contains: contains() over coalesced varchar', (r.sql || '').includes("contains(coalesce(CAST(c1 AS VARCHAR), ''), CAST(? AS VARCHAR))"));
  ok('filter contains: needle bound', r.params[0] === '01');
}
{
  const r = gen([{ type: 'filter', column: 'sku', op: 'contains' }]);
  ok('filter contains: omitted value → empty needle param', r.params.length === 1 && r.params[0] === '');
}
{
  const s = sqlOf([{ type: 'filter', column: 'city', op: 'is_empty' }]);
  ok('filter is_empty: explicit whitespace class, not trim()', s.includes("regexp_full_match(CAST(c0 AS VARCHAR), '[ \\x{0009}\\x{000a}\\x{000b}\\x{000c}\\x{000d}\\x{00a0}\\x{feff}]*')"));
  ok('filter is_empty: covers NULL too', s.includes('(c0 IS NULL OR regexp_full_match'));
  ok('filter is_empty: does not use trim()', !/\btrim\(/.test(s));
}
{
  const s = sqlOf([{ type: 'filter', column: 'city', op: 'not_empty' }]);
  ok('filter not_empty: negated shared predicate', s.includes('WHERE NOT (c0 IS NULL OR regexp_full_match'));
}
{
  // SECURITY: a hostile filter value must stay a parameter.
  const evil = "Paris' OR 1=1 --";
  const r = gen([{ type: 'filter', column: 'city', op: '=', value: evil }]);
  ok('injection: value never appears in the SQL text', !(r.sql || '').includes('OR 1=1'));
  ok('injection: value is the bound param verbatim', r.params.length === 1 && r.params[0] === evil);
}

// ── group_aggregate ──────────────────────────────────────────────────────────
{
  const r = gen([
    {
      type: 'group_aggregate',
      groupBy: ['city'],
      aggregations: [
        { column: 'units', fn: 'sum', as: 'total_units' },
        { column: 'price', fn: 'avg', as: 'avg_price' },
        { column: 'sku', fn: 'count', as: 'n' },
        { column: 'sku', fn: 'min', as: 'min_sku' },
      ],
    },
  ]);
  const s = r.sql || '';
  ok('group: fresh physical names for every output column', r.columns.map((c) => c.physical).join(',') === 'c4,c5,c6,c7,c8');
  ok('group: names/types = groupBy(source type) then aggs(number)', r.columns.map((c) => c.name + ':' + c.type).join(',') === 'city:text,total_units:number,avg_price:number,n:number,min_sku:number');
  ok('group: __ord propagates as min(__ord)', s.includes('min(__ord) AS __ord'));
  ok('group: outer ORDER BY __ord reproduces first-seen group order', s.includes('FROM s1 ORDER BY __ord'));
  ok('group: GROUP BY uses the physical key', s.includes('GROUP BY c0'));
  ok('group: sum wrapped in CAST(... AS DOUBLE) (no HUGEINT/BigInt)', s.includes('CAST(sum(CASE WHEN isfinite(TRY_CAST(c2 AS DOUBLE))'));
  ok('group: avg wrapped in CAST(... AS DOUBLE)', s.includes('CAST(avg(CASE WHEN isfinite(TRY_CAST(c3 AS DOUBLE))'));
  ok('group: count uses the non-empty FILTER form, not count(col)', s.includes('CAST(count(*) FILTER (WHERE NOT (c1 IS NULL OR regexp_full_match'));
  ok('group: min over a TEXT column → CAST(NULL AS DOUBLE), never min(VARCHAR)', s.includes('CAST(NULL AS DOUBLE) AS c8') && !s.includes('min(c1)'));
  ok('group: no HAVING when there are group keys', !s.includes('HAVING'));
  ok('group: no warnings', r.warnings.length === 0);
}
{
  const r = gen([{ type: 'group_aggregate', groupBy: [], aggregations: [{ column: 'units', fn: 'sum', as: 't' }] }]);
  ok('group: empty groupBy → HAVING count(*) > 0 (0 rows on empty input)', (r.sql || '').includes('HAVING count(*) > 0'));
  ok('group: empty groupBy → no GROUP BY clause', !/GROUP BY/.test(r.sql || ''));
}
{
  const r = gen([{ type: 'group_aggregate', groupBy: ['city'], aggregations: [] }]);
  ok('group: no aggregations → distinct projection of the keys', (r.sql || '').includes('SELECT c0 AS c4, min(__ord) AS __ord FROM s0 GROUP BY c0'));
}
{
  const r = gen([{ type: 'group_aggregate', groupBy: ['city', 'city'], aggregations: [] }]);
  ok('group: duplicated groupBy → two output columns, one GROUP BY key', (r.sql || '').includes('SELECT c0 AS c4, c0 AS c5, min(__ord) AS __ord FROM s0 GROUP BY c0') && r.columns.length === 2);
}
{
  const r = gen([{ type: 'group_aggregate', groupBy: ['city'], aggregations: [{ column: 'nope', fn: 'sum', as: 'x' }] }]);
  ok('group: missing agg column warns ONCE and does not skip the step', r.warnings.length === 1 && r.warnings[0] === 'Aggregation "x" references unknown column "nope"');
  ok('group: missing agg column → CAST(NULL AS DOUBLE)', (r.sql || '').includes('CAST(NULL AS DOUBLE) AS c5'));
}
{
  // Unknown fn falls back to count, silently — transforms.aggregate:368.
  const r = gen([{ type: 'group_aggregate', groupBy: ['city'], aggregations: [{ column: 'units', fn: 'median' as never, as: 'm' }] }]);
  ok('group: unknown fn falls back to count with no warning', r.warnings.length === 0 && (r.sql || '').includes('count(*) FILTER'));
}

// ── dedupe ───────────────────────────────────────────────────────────────────
{
  const s = sqlOf([{ type: 'dedupe' }]);
  ok('dedupe: all columns → QUALIFY row_number over every physical column', s.includes('QUALIFY row_number() OVER (PARTITION BY c0, c1, c2, c3 ORDER BY __ord) = 1'));
  ok('dedupe: first-wins via ORDER BY __ord, never DISTINCT', !s.includes('DISTINCT'));
}
{
  const r = gen([{ type: 'dedupe', columns: ['city', 'nope'] }]);
  ok('dedupe: unknown column warns and is ignored', r.warnings.length === 1 && r.warnings[0] === 'Dedupe: unknown column "nope" ignored');
  ok('dedupe: surviving key still generates', (r.sql || '').includes('PARTITION BY c0 ORDER BY __ord'));
}

// ── fill_empty ───────────────────────────────────────────────────────────────
{
  const r = gen([{ type: 'fill_empty', column: 'city', value: 'Unknown' }]);
  const s = r.sql || '';
  ok('fill_empty: CASE over the shared emptiness predicate', s.includes('CASE WHEN (c0 IS NULL OR regexp_full_match(CAST(c0 AS VARCHAR)'));
  ok('fill_empty: fill value is a bound param', s.includes('THEN CAST(? AS VARCHAR) ELSE CAST(c0 AS VARCHAR) END AS c0') && r.params[0] === 'Unknown');
  ok('fill_empty: column flagged for the TS retype pass', r.retypeColumns.join(',') === 'c0');
  ok('fill_empty: physical name preserved', r.columns[0].physical === 'c0');
}
{
  const r = gen([{ type: 'fill_empty', column: 'units', value: 0 }]);
  ok('fill_empty: numeric fill stringified for the retype pass', r.params[0] === '0');
}
{
  // The retype makes the column's declared type data-dependent — any later step
  // that branches on that type is not faithfully expressible.
  const r = gen([
    { type: 'fill_empty', column: 'units', value: 'n/a' },
    { type: 'filter', column: 'units', op: '>', value: 1 },
  ]);
  ok('fill_empty: a later type-sensitive filter bails to sql:null', r.sql === null && /retyped by an earlier fill_empty/.test(r.unsupported || ''));
}
{
  const r = gen([
    { type: 'fill_empty', column: 'units', value: 'n/a' },
    { type: 'filter', column: 'units', op: 'not_empty' },
  ]);
  ok('fill_empty: a later type-INsensitive filter still generates', r.sql !== null);
}

// ── trim ─────────────────────────────────────────────────────────────────────
{
  const r = gen([{ type: 'trim', column: 'city' }]);
  ok('trim named: regexp_replace with the explicit class, aliased back', (r.sql || '').includes("regexp_replace(CAST(c0 AS VARCHAR), '^[ \\x{0009}\\x{000a}\\x{000b}\\x{000c}\\x{000d}\\x{00a0}\\x{feff}]+|[ \\x{0009}\\x{000a}\\x{000b}\\x{000c}\\x{000d}\\x{00a0}\\x{feff}]+$', '', 'g') AS c0"));
  ok('trim named: only that column rewritten', (r.sql || '').includes('AS c0, c1, c2, c3'));
}
{
  const r = gen([{ type: 'trim' }]);
  const s = r.sql || '';
  ok('trim all: every TEXT column rewritten', s.includes('AS c0,') && s.includes('AS c1,'));
  ok('trim all: number columns untouched', !s.includes('AS c2') && !s.includes('AS c3'));
}
{
  const r = gen([{ type: 'trim', column: '' }]);
  ok("trim: column '' is falsy → all-text branch, not a skip", r.warnings.length === 0 && (r.sql || '').includes('regexp_replace'));
}
{
  const r = gen([{ type: 'trim', column: 'units' }]);
  ok('trim: a named NUMBER column is a no-op (no CTE, no warning)', cteCount(r.sql || '') === 1 && r.warnings.length === 0);
}
{
  const dateCols: SqlColumn[] = [{ physical: 'c0', name: 'd', type: 'date' }];
  ok('trim all: date columns are NOT trimmed', cteCount(sqlOf([{ type: 'trim' }], dateCols)) === 1);
  ok('trim named: a date column IS trimmed', sqlOf([{ type: 'trim', column: 'd' }], dateCols).includes('regexp_replace'));
}

// ── drop_column / rename_column ──────────────────────────────────────────────
{
  const r = gen([{ type: 'drop_column', column: 'sku' }]);
  ok('drop_column: projection loses the column', (r.sql || '').includes('SELECT __ord, c0, c2, c3 FROM s0'));
  ok('drop_column: schema loses the column', r.columns.map((c) => c.name).join(',') === 'city,units,price');
}
{
  const r = gen([{ type: 'rename_column', from: 'units', to: 'quantity' }]);
  ok('rename_column: emits ZERO SQL (metadata only)', cteCount(r.sql || '') === 1 && (r.sql || '').includes('FROM s0 ORDER BY __ord'));
  ok('rename_column: new name is in the metadata', r.columns[2].name === 'quantity');
  ok('rename_column: physical identifier unchanged', r.columns[2].physical === 'c2');
  ok('rename_column: user name never reaches the SQL', !(r.sql || '').includes('quantity'));
}
{
  // No collision check, exactly like transforms — two columns named `price`; a
  // later reference resolves to the FIRST match.
  const r = gen([
    { type: 'rename_column', from: 'units', to: 'price' },
    { type: 'drop_column', column: 'price' },
  ]);
  ok('rename_column: duplicate names allowed, first match wins', r.columns.map((c) => c.physical).join(',') === 'c0,c1,c3');
}

// ── Guards: exact warning strings, and NO CTE for the skipped step ───────────
{
  const cases: [string, TransformStep, string][] = [
    ['filter unknown column', { type: 'filter', column: 'nope', op: '=', value: 1 }, 'Filter skipped: unknown column "nope"'],
    ['filter unknown operator', { type: 'filter', column: 'city', op: '~' as never }, 'Filter skipped: unknown operator "~"'],
    ['group unknown key', { type: 'group_aggregate', groupBy: ['nope', 'city'], aggregations: [] }, 'Group/aggregate skipped: unknown group column(s): nope'],
    ['dedupe no key resolves', { type: 'dedupe', columns: ['nope'] }, 'Dedupe: unknown column "nope" ignored'],
    ['fill_empty unknown column', { type: 'fill_empty', column: 'nope', value: 'x' }, 'Fill empty skipped: unknown column "nope"'],
    ['trim unknown column', { type: 'trim', column: 'nope' }, 'Trim skipped: unknown column "nope"'],
    ['drop unknown column', { type: 'drop_column', column: 'nope' }, 'Drop column skipped: unknown column "nope"'],
    ['rename unknown column', { type: 'rename_column', from: 'nope', to: 'x' }, 'Rename skipped: unknown column "nope"'],
    ['rename blank new name', { type: 'rename_column', from: 'city', to: '   ' }, 'Rename skipped: blank new name for "city"'],
    ['unknown step type', { type: 'frobnicate' } as never, 'Unknown step type "frobnicate" skipped'],
    ['calculated_field blank name', { type: 'calculated_field', name: '  ', expression: '1' }, 'Calculated field skipped: blank column name'],
    ['calculated_field duplicate name', { type: 'calculated_field', name: 'city', expression: '1' }, 'Calculated field skipped: column "city" already exists'],
  ];
  for (const [label, step, want] of cases) {
    const r = gen([step]);
    ok('guard warning — ' + label, r.warnings.includes(want));
    ok('guard emits no CTE — ' + label, cteCount(r.sql || '') === 1);
    ok('guard leaves the schema intact — ' + label, r.columns.length === 4);
  }
  const seq = gen([
    { type: 'filter', column: 'nope', op: '=', value: 1 },
    { type: 'filter', column: 'units', op: '>', value: 2 },
  ]);
  ok('guard: the chain continues from the previous CTE', (seq.sql || '').includes('s2 AS (SELECT __ord, c0, c1, c2, c3 FROM s0 WHERE') && (seq.sql || '').includes('FROM s2 ORDER BY __ord'));
  ok('guard: CTE names stay aligned to step indices (s1 never emitted)', !(seq.sql || '').includes('s1 AS ('));
}

// ── sql: null cases ──────────────────────────────────────────────────────────
{
  const r = gen([{ type: 'calculated_field', name: 'total', expression: 'units * price' }]);
  ok('calculated_field: returns sql null', r.sql === null);
  ok('calculated_field: unsupported names the formula gap', /formula/.test(r.unsupported || ''));
  ok('calculated_field: params emptied', r.params.length === 0);
}
{
  const one: SqlColumn[] = [{ physical: 'c0', name: 'only', type: 'text' }];
  const r = gen([{ type: 'drop_column', column: 'only' }], one);
  ok('zero columns: returns sql null', r.sql === null);
  ok('zero columns: unsupported names the parser error', /empty select list/.test(r.unsupported || ''));
}
{
  const bad: SqlColumn[] = [{ physical: 'city"; DROP TABLE x; --', name: 'city', type: 'text' }];
  ok('safety: a non-positional physical identifier is rejected', sqlGen.generateSql('ds', bad, []).sql === null);
}
{
  ok('safety: a blank relation name is rejected', sqlGen.generateSql('', COLS, []).sql === null);
  ok('safety: a hostile relation name is quote-escaped', (sqlGen.generateSql('a"b', COLS, []).sql || '').includes('FROM "a""b"'));
}

// ── Composition: steps compose left→right, __ord survives to the end ─────────
{
  const r = gen([
    { type: 'filter', column: 'units', op: '>', value: 0 },
    { type: 'dedupe', columns: ['city'] },
    { type: 'group_aggregate', groupBy: ['city'], aggregations: [{ column: 'price', fn: 'sum', as: 'total' }] },
    { type: 'rename_column', from: 'total', to: 'revenue' },
  ]);
  const s = r.sql || '';
  ok('compose: three CTEs (rename emits none)', cteCount(s) === 4);
  ok('compose: each CTE reads the previous one', s.includes('FROM s0 WHERE') && s.includes('FROM s1 QUALIFY') && s.includes('FROM s2 GROUP BY'));
  ok('compose: final schema is renamed metadata', r.columns.map((c) => c.name).join(',') === 'city,revenue');
  ok('compose: single trailing ORDER BY __ord', (s.match(/ORDER BY __ord$/m) || []).length === 1);
}

// ── DuckDB CLI validation — the generated SQL must actually parse and run ─────

function duckdbAvailable(): boolean {
  try {
    execFileSync('duckdb', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function lit(v: string | number | null): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + v.replace(/'/g, "''") + "'";
}

// PREPARE keeps the `?` placeholders real; EXECUTE supplies the values.
function run(setup: string, sql: string, params: (string | number | null)[]): string {
  const exec = params.length ? `EXECUTE q(${params.map(lit).join(', ')});` : 'EXECUTE q;';
  const script = `${setup}\nPREPARE q AS ${sql};\n${exec}`;
  // Strip only the trailing newline — a leading blank line is a real empty-string row.
  return execFileSync('duckdb', ['-csv', '-noheader', '-c', script], { encoding: 'utf8' }).replace(/\r?\n$/, '');
}

if (!duckdbAvailable()) {
  console.log('skip duckdb CLI not found — skipping execution checks');
} else {
  const FIXTURE =
    "CREATE TABLE ds AS SELECT * FROM (VALUES " +
    "(0,'Paris','007','3','10')," +
    "(1,'Berlin','012','5','20')," +
    "(2,'Paris','007','2','10')," +
    "(3,'Berlin','020','0','5')" +
    ') t(__ord, c0, c1, c2, c3);';

  const check = (label: string, steps: TransformStep[], want: string, cols: SqlColumn[] = COLS, setup = FIXTURE): void => {
    const r = gen(steps, cols);
    let got: string;
    try {
      got = run(setup, r.sql || '', r.params);
    } catch (e) {
      got = 'ERROR: ' + (e instanceof Error ? e.message : String(e));
    }
    if (got !== want) console.error(`     want ${JSON.stringify(want)}\n     got  ${JSON.stringify(got)}`);
    ok('duckdb — ' + label, got === want);
  };

  check('passthrough keeps source row order', [], 'Paris,007,3,10\nBerlin,012,5,20\nParis,007,2,10\nBerlin,020,0,5');
  check('numeric filter', [{ type: 'filter', column: 'units', op: '>', value: 2 }], 'Paris,007,3,10\nBerlin,012,5,20');
  check('numeric filter != against a non-lossless value drops everything', [{ type: 'filter', column: 'units', op: '!=', value: '007' }], '');
  check('text equality filter', [{ type: 'filter', column: 'city', op: '=', value: 'Paris' }], 'Paris,007,3,10\nParis,007,2,10');
  check('contains is a substring test on the stringified cell', [{ type: 'filter', column: 'sku', op: 'contains', value: '01' }], 'Berlin,012,5,20');
  check(
    'group_aggregate in first-seen group order via min(__ord)',
    [{ type: 'group_aggregate', groupBy: ['city'], aggregations: [{ column: 'units', fn: 'sum', as: 'total_units' }, { column: 'price', fn: 'avg', as: 'avg_price' }, { column: 'sku', fn: 'count', as: 'n' }, { column: 'sku', fn: 'min', as: 'min_sku' }] }],
    'Paris,5.0,10.0,2.0,NULL\nBerlin,5.0,12.5,2.0,NULL',
  );
  check('dedupe keeps the FIRST occurrence per key', [{ type: 'dedupe', columns: ['city'] }], 'Paris,007,3,10\nBerlin,012,5,20');
  check('dedupe over all columns', [{ type: 'dedupe' }], 'Paris,007,3,10\nBerlin,012,5,20\nParis,007,2,10\nBerlin,020,0,5');
  check('trim (named)', [{ type: 'trim', column: 'city' }], 'Paris,007,3,10\nBerlin,012,5,20\nParis,007,2,10\nBerlin,020,0,5');
  check('drop_column', [{ type: 'drop_column', column: 'sku' }], 'Paris,3,10\nBerlin,5,20\nParis,2,10\nBerlin,0,5');
  check('rename_column is a no-op in SQL', [{ type: 'rename_column', from: 'units', to: 'quantity' }], 'Paris,007,3,10\nBerlin,012,5,20\nParis,007,2,10\nBerlin,020,0,5');
  check(
    'composed pipeline: filter → group → rename',
    [
      { type: 'filter', column: 'units', op: '>', value: 0 },
      { type: 'group_aggregate', groupBy: ['city'], aggregations: [{ column: 'price', fn: 'sum', as: 'total' }] },
      { type: 'rename_column', from: 'total', to: 'revenue' },
    ],
    'Paris,20.0\nBerlin,20.0',
  );
  check('fill_empty leaves non-empty cells alone', [{ type: 'fill_empty', column: 'city', value: 'Unknown' }], 'Paris,007,3,10\nBerlin,012,5,20\nParis,007,2,10\nBerlin,020,0,5');

  // Emptiness fixture: 'a', '', tab+NBSP, NULL — only ONE non-empty cell.
  const EMPTY_FIXTURE =
    "CREATE TABLE ds AS SELECT * FROM (VALUES " +
    "(0,'a')," +
    "(1,'')," +
    "(2,chr(9)||chr(160))," +
    '(3,NULL)' +
    ') t(__ord, c0);';
  const oneText: SqlColumn[] = [{ physical: 'c0', name: 'v', type: 'text' }];

  check('is_empty catches NULL, \'\', tab and NBSP', [{ type: 'filter', column: 'v', op: 'is_empty' }], '\n"\t\u00a0"\nNULL', oneText, EMPTY_FIXTURE);
  check('not_empty keeps only the real value', [{ type: 'filter', column: 'v', op: 'not_empty' }], 'a', oneText, EMPTY_FIXTURE);
  check(
    'count excludes \'\' and whitespace-only (DuckDB count() would say 3)',
    [{ type: 'group_aggregate', groupBy: [], aggregations: [{ column: 'v', fn: 'count', as: 'n' }] }],
    '1.0',
    oneText,
    EMPTY_FIXTURE,
  );
  check('fill_empty replaces NULL/\'\'/whitespace only', [{ type: 'fill_empty', column: 'v', value: 'Z' }], 'a\nZ\nZ\nZ', oneText, EMPTY_FIXTURE);
  check('trim strips tab and NBSP (DuckDB trim() would leave the tab)', [{ type: 'trim' }], 'a\n\n\nNULL', oneText, EMPTY_FIXTURE);

  // Global aggregate over an EMPTY relation must return ZERO rows, not one NULL row.
  const EMPTY_TABLE = 'CREATE TABLE ds (__ord BIGINT, c0 VARCHAR);';
  check(
    'empty groupBy over an empty table → 0 rows (HAVING count(*) > 0)',
    [{ type: 'group_aggregate', groupBy: [], aggregations: [{ column: 'v', fn: 'count', as: 'n' }] }],
    '',
    oneText,
    EMPTY_TABLE,
  );

  // A hostile value must be inert even when it round-trips through DuckDB.
  {
    const r = gen([{ type: 'filter', column: 'city', op: '=', value: "Paris' OR 1=1 --" }]);
    let got = '';
    try {
      got = run(FIXTURE, r.sql || '', r.params);
    } catch (e) {
      got = 'ERROR';
    }
    ok('duckdb — injected filter value matches nothing', got === '');
  }
}

if (failures) {
  console.error('\n' + failures + ' sqlGen check(s) FAILED');
  process.exit(1);
}
console.log('\nAll sqlGen checks passed.');
