// Self-check for `visual:rows` — the rows behind one mark (src/ipc/visuals.ts).
//
// The feature exists so a user can CHECK the app's arithmetic, which means the
// only assertion that really matters is: the rows the panel lists, re-aggregated,
// reproduce the number the chart drew. So the centre of this suite is
// differential — `buildVizData` computes a bar, `visual:rows` fetches that bar's
// rows through the SHIPPED handler (captured by stubbing `ipcMain.handle`), and
// the two are compared. A hand-written row count could agree with a bug in both;
// an equivalence assertion cannot.
//
// Around that sit the composition and refusal checks, which are about honesty
// rather than arithmetic: every shape whose row set cannot be derived EXACTLY
// must return `available: false` and a reason, and must never return a partial
// or approximate row set instead.
//
//   npm run build:ts && node scripts/test-visual-rows.js

export {}; // module scope — sibling test scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-drill-'));

// ── The electron stub ────────────────────────────────────────────────────────
// Point userData at a temp dir and CAPTURE every ipcMain.handle registration, so
// the real, shipped handler is invoked rather than a copy of its logic.
const handlers = new Map<string, (e: unknown, arg: unknown) => Promise<any>>();

// The save panel is stubbed rather than shown: `saveTo` is where the next
// export lands, and `null` stands for the user cancelling.
let saveTo: string | null = null;
let messageBoxes = 0;

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData },
      ipcMain: {
        handle: (channel: string, fn: (e: unknown, arg: unknown) => Promise<any>) => {
          handlers.set(channel, fn);
        },
      },
      dialog: {
        showSaveDialog: async () => (saveTo ? { canceled: false, filePath: saveTo } : { canceled: true }),
        showMessageBox: async () => {
          messageBoxes += 1;
          return { response: 0 };
        },
      },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings.
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/projects') = require('../src/projects');
const vizData: typeof import('../src/vizData') = require('../src/vizData');
const visualsMod: typeof import('../src/visuals') = require('../src/visuals');
const ipcVisuals: typeof import('../src/ipc/visuals') = require('../src/ipc/visuals');

type ParsedColumn = import('../src/data/parse').ParsedColumn;
type Cell = import('../src/data/transforms').Cell;
type FilterStep = import('../src/data/transforms').FilterStep;
type VizEncoding = import('../src/visuals').VizEncoding;

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else {
    console.error('FAIL ' + label);
    failures++;
  }
}

// ── Fixture ──────────────────────────────────────────────────────────────────

const COLUMNS: ParsedColumn[] = [
  { name: 'region', type: 'text' },
  { name: 'channel', type: 'text' }, // the split column
  { name: 'code', type: 'text' }, // '007' must stay '007'
  { name: 'amount', type: 'number' },
  { name: 'day', type: 'date' },
];

// Deliberate content: repeated (region, channel) pairs so a pivot cell covers
// several rows; null AND '' AND whitespace in the category, so a blank label is
// genuinely ambiguous; '007' next to '7'; a null measure (empty ≠ zero).
const ROWS: Cell[][] = [
  ['North', 'Web', '007', 10, '2024-01-01'],
  ['North', 'Web', '7', 5, '2024-01-02'],
  ['North', 'Store', '007', 20, '2024-01-03'],
  ['South', 'Web', '07', null, '2024-01-04'],
  ['South', 'Store', '7', 8, '2024-01-05'],
  ['South', 'Store', '007', 2, '2024-01-06'],
  ['East', 'Web', '0070', 0, '2024-01-07'],
  ['', 'Web', '7', 3, '2024-01-08'],
  [null, 'Store', '007', 4, '2024-01-09'],
  ['   ', 'Web', '07', 6, '2024-01-10'],
  ['North', 'Store', '7', -1, '2024-01-11'],
  ['East', 'Store', '007', 9, '2024-01-12'],
];

let projectId = '';
let fixtureId = '';
let stored: { columns: ParsedColumn[]; rows: Cell[][] } = { columns: [], rows: [] };

let visualRows!: (e: unknown, arg: unknown) => Promise<any>;

function cleanup(): void {
  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** `visual:rows` with the whole (filtered) set in one window. */
async function drill(
  encoding: unknown,
  filters: unknown,
  mark: unknown,
  page?: Record<string, unknown>,
): Promise<any> {
  return visualRows(null, {
    projectId,
    datasetId: fixtureId,
    encoding,
    filters,
    mark,
    page: { offset: 0, limit: 500, ...(page || {}) },
  });
}

function isFilter(s: any, column: string, value: Cell): boolean {
  return Boolean(s) && s.type === 'filter' && s.column === column && s.op === '=' && Object.is(s.value, value);
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const project = await projects.createProject('Drill');
  projectId = project.id;
  const ds = await datasets.saveDataset(projectId, {
    name: 'sales',
    sourceKind: 'csv',
    columns: COLUMNS,
    rows: ROWS,
  });
  if (!ds) throw new Error('saveDataset failed');
  fixtureId = ds.id;
  const back = await datasets.getDataset(projectId, fixtureId);
  if (!back) throw new Error('getDataset failed');
  stored = { columns: back.columns, rows: back.rows };

  ipcVisuals.register();
  const h = handlers.get('visual:rows');
  if (!h) {
    console.error('FAIL visual:rows was never registered — nothing was verified');
    cleanup();
    process.exit(1);
  }
  visualRows = h;

  // ── 1. THE assertion: the drilled rows reproduce the drawn figure ──────────
  //
  // For every bar of a real chart, fetch its rows and re-aggregate them here,
  // in the test, with plain JS. The result must equal the value `buildVizData`
  // drew. This is what "the app does the math and never invents a figure"
  // means operationally — and it fails if the drill filters select any other
  // set, whether wider or narrower.
  {
    const encoding: VizEncoding = visualsMod.sanitizeEncoding({
      category: 'region',
      values: [{ column: 'amount', aggregation: 'sum' }],
    });
    const ref = vizData.buildVizData(stored.columns, stored.rows, encoding, []);
    const amountIdx = 3;
    let checked = 0;

    for (let i = 0; i < ref.data.labels.length; i += 1) {
      const label = ref.data.labels[i];
      const drawn = ref.data.series[0].values[i];
      const res = await drill(encoding, [], { category: label });

      // A blank label is the ambiguous case and is asserted separately in §3.
      if (String(label).trim() === '') {
        ok(`bar ${JSON.stringify(label)}: blank label refused, not approximated`, res.ok === true && res.available === false);
        continue;
      }
      if (!res || res.ok !== true || res.available !== true) {
        ok(`bar ${JSON.stringify(label)}: rows available`, false);
        continue;
      }
      const sum = res.rows.reduce(
        (acc: number | null, r: Cell[]) => (typeof r[amountIdx] === 'number' ? (acc ?? 0) + (r[amountIdx] as number) : acc),
        null as number | null,
      );
      ok(
        `bar ${JSON.stringify(label)}: ${res.rows.length} rows re-sum to the drawn ${JSON.stringify(drawn)}`,
        Object.is(sum, drawn),
      );
      // …and every row really does belong to the bar.
      ok(
        `bar ${JSON.stringify(label)}: every returned row matches the mark`,
        res.rows.every((r: Cell[]) => String(r[0] ?? '') === String(label)),
      );
      checked += 1;
    }
    ok('every non-blank bar was checked', checked === 3); // North, South, East
  }

  // ── 2. A split chart: exactly two equality filters, and the pivot CELL ─────
  {
    const encoding: VizEncoding = visualsMod.sanitizeEncoding({
      category: 'region',
      series: 'channel',
      values: [{ column: 'amount', aggregation: 'sum' }],
    });
    const ref = vizData.buildVizData(stored.columns, stored.rows, encoding, []);
    const res = await drill(encoding, [], { category: 'North', series: 'Store' });
    ok('split: available', res.ok === true && res.available === true);
    ok('split: exactly two equality filters were added', res.filters.length === 2);
    ok('split: the category filter', isFilter(res.filters[0], 'region', 'North'));
    ok('split: the series filter', isFilter(res.filters[1], 'channel', 'Store'));

    // The pivot cell (North, Store) — re-summed from the drilled rows.
    const si = ref.data.series.findIndex((s: any) => s.name === 'Store');
    const ci = ref.data.labels.indexOf('North');
    const drawn = ref.data.series[si].values[ci];
    const sum = res.rows.reduce(
      (acc: number | null, r: Cell[]) => (typeof r[3] === 'number' ? (acc ?? 0) + (r[3] as number) : acc),
      null as number | null,
    );
    ok(`split: the (North, Store) cell re-sums to the drawn ${JSON.stringify(drawn)}`, Object.is(sum, drawn));
    ok(
      'split: every row matches BOTH halves of the mark',
      res.rows.length > 0 && res.rows.every((r: Cell[]) => r[0] === 'North' && r[1] === 'Store'),
    );
  }

  // ── 3. Composition order, and the visual/sheet filters coming first ────────
  {
    const encoding: VizEncoding = visualsMod.sanitizeEncoding({
      category: 'region',
      values: [{ column: 'amount', aggregation: 'sum' }],
    });
    const passed: FilterStep[] = [
      { type: 'filter', column: 'channel', op: '=', value: 'Web' },
      { type: 'filter', column: 'amount', op: '>', value: 1 },
    ];
    const res = await drill(encoding, passed, { category: 'North' });
    ok('composition: the caller filters are kept, in order, then the mark', res.filters.length === 3);
    ok('composition: [0] is the caller first filter', isFilter(res.filters[0], 'channel', 'Web'));
    ok('composition: [1] is the caller second filter', res.filters[1].column === 'amount' && res.filters[1].op === '>');
    ok('composition: [2] is the mark', isFilter(res.filters[2], 'region', 'North'));
    ok(
      'composition: the rows honour every one of them',
      res.rows.length > 0 &&
        res.rows.every((r: Cell[]) => r[0] === 'North' && r[1] === 'Web' && (r[3] as number) > 1),
    );

    // No mark at all — the ⋯ entry point. Just the filters, no refusal.
    const noMark = await drill(encoding, passed, undefined);
    ok('no mark: available, with the caller filters unchanged', noMark.available === true && noMark.filters.length === 2);
    const bare = await drill(encoding, [], {});
    ok('empty mark object: treated as no mark', bare.available === true && bare.filters.length === 0);
    ok('no mark: returns the whole filtered set', noMark.total > 0);
  }

  // ── 4. Every refusal path: available:false, a reason, and NO rows ──────────
  //
  // "Never a partial row set" is the load-bearing half — a refusal that also
  // shipped rows would be exactly the quiet contradiction this design avoids.
  {
    const agg = [{ column: 'amount', aggregation: 'sum' }];
    const cases: { label: string; encoding: unknown; mark: unknown }[] = [
      {
        label: 'raw chart (branch C: one point per row)',
        encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'none' }] },
        mark: { category: 'North' },
      },
      {
        label: 'map region',
        encoding: { category: 'region', values: agg, geo: { level: 'us_state' } },
        mark: { category: 'North' },
      },
      {
        label: 'no category column in the encoding',
        encoding: { category: '', values: agg },
        mark: { category: 'North' },
      },
      {
        label: 'category is not a stored column (e.g. a calculated field)',
        encoding: { category: 'margin_pct', values: agg },
        mark: { category: 'North' },
      },
      {
        label: 'blank label: null and "" are two groups that both render blank',
        encoding: { category: 'region', values: agg },
        mark: { category: '' },
      },
      {
        label: 'whitespace-only label is blank too',
        encoding: { category: 'region', values: agg },
        mark: { category: '   ' },
      },
      {
        label: 'a number column cannot be matched on a non-numeric label',
        encoding: { category: 'amount', values: agg },
        mark: { category: '007' },
      },
      {
        label: 'split chart, mark with no series (half a pivot cell)',
        encoding: { category: 'region', series: 'channel', values: agg },
        mark: { category: 'North' },
      },
      {
        label: 'series on a chart that has no split column',
        encoding: { category: 'region', values: agg },
        mark: { category: 'North', series: 'Web' },
      },
    ];

    for (const c of cases) {
      const res = await drill(c.encoding, [], c.mark);
      const refused =
        res &&
        res.ok === true &&
        res.available === false &&
        typeof res.reason === 'string' &&
        res.reason.length > 0 &&
        res.rows === undefined &&
        res.total === undefined;
      ok(`refuses: ${c.label}`, Boolean(refused));
    }
  }

  // ── 5. Paging, searching and sorting the drilled set ──────────────────────
  {
    const encoding: VizEncoding = visualsMod.sanitizeEncoding({
      category: 'channel',
      values: [{ column: 'amount', aggregation: 'count' }],
    });
    const all = await drill(encoding, [], { category: 'Store' });
    const firstTwo = await drill(encoding, [], { category: 'Store' }, { offset: 0, limit: 2 });
    const nextTwo = await drill(encoding, [], { category: 'Store' }, { offset: 2, limit: 2 });
    ok('paging: total is the FILTERED count, independent of the window', firstTwo.total === all.total && all.total > 4);
    ok('paging: the window is bounded by limit', firstTwo.rows.length === 2 && nextTwo.rows.length === 2);
    ok(
      'paging: consecutive windows are disjoint slices of the same order',
      JSON.stringify(firstTwo.rows.concat(nextTwo.rows)) === JSON.stringify(all.rows.slice(0, 4)),
    );

    // The search runs in main against the filtered set — never over a whole
    // table shipped to the renderer.
    const searched = await drill(encoding, [], { category: 'Store' }, { search: 'North' });
    ok(
      'search: narrows within the mark, and only within it',
      searched.total < all.total &&
        searched.rows.length > 0 &&
        searched.rows.every((r: Cell[]) => r[1] === 'Store' && String(r[0] ?? '').includes('North')),
    );

    const sorted = await drill(encoding, [], { category: 'Store' }, { sortColumn: 'amount', sortDir: 'desc' });
    const amounts = sorted.rows.map((r: Cell[]) => r[3]).filter((v: Cell) => typeof v === 'number') as number[];
    ok(
      'sort: descending by a number column',
      sorted.total === all.total && amounts.every((v, i) => i === 0 || amounts[i - 1] >= v),
    );
  }

  // ── 6. '007' is never read as 7 on the way through ────────────────────────
  {
    const encoding: VizEncoding = visualsMod.sanitizeEncoding({
      category: 'code',
      values: [{ column: 'amount', aggregation: 'sum' }],
    });
    const res = await drill(encoding, [], { category: '007' });
    ok('leading zeros: the mark filter carries the string verbatim', isFilter(res.filters[0], 'code', '007'));
    ok(
      "leading zeros: only '007' rows come back — not '7', '07' or '0070'",
      res.rows.length > 0 && res.rows.every((r: Cell[]) => r[2] === '007'),
    );
    const ref = vizData.buildVizData(stored.columns, stored.rows, encoding, []);
    const i = ref.data.labels.indexOf('007');
    const sum = res.rows.reduce(
      (acc: number | null, r: Cell[]) => (typeof r[3] === 'number' ? (acc ?? 0) + (r[3] as number) : acc),
      null as number | null,
    );
    ok("leading zeros: the '007' bar re-sums correctly", Object.is(sum, ref.data.series[0].values[i]));
  }

  // ── 7. CSV export: the file IS the grid ───────────────────────────────────
  //
  // Same filters, same search, same order, every row — not the window on screen
  // and not the unfiltered table.
  {
    const exportRows = handlers.get('visual:rowsExport');
    if (!exportRows) {
      ok('visual:rowsExport was registered', false);
    } else {
      const encoding: VizEncoding = visualsMod.sanitizeEncoding({
        category: 'region',
        values: [{ column: 'amount', aggregation: 'sum' }],
      });
      const mark = { category: 'North' };
      const shown = await drill(encoding, [], mark);

      saveTo = path.join(tmpUserData, 'north.csv');
      const res = await exportRows(null, {
        projectId,
        datasetId: fixtureId,
        encoding,
        filters: [],
        mark,
        page: {},
        name: 'amount by region',
      });
      ok('export: ok, with the row count written', res.ok === true && res.rows === shown.total);

      const text = fs.readFileSync(saveTo, 'utf8');
      const lines = text.split('\r\n').filter((l: string) => l !== '');
      ok('export: RFC-4180 CRLF line endings', text.includes('\r\n'));
      ok('export: no BOM at the head of the file', !text.startsWith('﻿'));
      ok('export: a header line plus one line per row', lines.length === shown.total + 1);
      ok('export: the header is the column names', lines[0] === 'region,channel,code,amount,day');
      ok(
        'export: every data line belongs to the mark',
        lines.slice(1).every((l: string) => l.startsWith('North,')),
      );
      ok("export: '007' survives as text, unquoted and unmangled", text.includes(',007,'));

      // A null cell is an EMPTY FIELD, not the text "null".
      ok('export: a null cell is an empty field', !/,null,|,null$/.test(text));

      // The search narrows the FILE, not just the grid.
      saveTo = path.join(tmpUserData, 'north-web.csv');
      const searched = await exportRows(null, {
        projectId,
        datasetId: fixtureId,
        encoding,
        filters: [],
        mark,
        page: { search: 'Web' },
        name: 'x',
      });
      const searchedLines = fs.readFileSync(saveTo, 'utf8').split('\r\n').filter((l: string) => l !== '');
      ok(
        'export: the search applies to the file too',
        searched.ok === true && searchedLines.length === searched.rows + 1 && searched.rows < res.rows,
      );
      ok('export: …and every exported row matches it', searchedLines.slice(1).every((l: string) => l.includes('Web')));

      // Cancelling the save panel writes nothing.
      saveTo = null;
      const canceled = await exportRows(null, {
        projectId,
        datasetId: fixtureId,
        encoding,
        filters: [],
        mark,
        page: {},
        name: 'x',
      });
      ok('export: cancelling writes no file', canceled.ok === false && canceled.canceled === true);

      // A refused drill cannot be exported either — the same lock, twice.
      saveTo = path.join(tmpUserData, 'never.csv');
      const refused = await exportRows(null, {
        projectId,
        datasetId: fixtureId,
        encoding,
        filters: [],
        mark: { category: '' },
        page: {},
        name: 'x',
      });
      ok(
        'export: a refused drill exports nothing, with the reason',
        refused.ok === false && typeof refused.error === 'string' && !fs.existsSync(saveTo),
      );
      ok('export: no size warning was shown for a small set', messageBoxes === 0);
    }
  }

  // ── 8. RFC-4180 quoting, at the unit ─────────────────────────────────────
  {
    const line = ipcVisuals.csvLine(['plain', 'has,comma', 'has"quote', 'has\nnewline', null, '', 0, '007']);
    ok(
      'csvLine: quotes only what needs it, doubles embedded quotes, null → empty',
      line === 'plain,"has,comma","has""quote","has\nnewline",,,0,007',
    );
  }

  // ── 9. A missing dataset is an error, never an empty "available" answer ────
  {
    const res = await visualRows(null, {
      projectId,
      datasetId: '00000000-0000-4000-8000-000000000000',
      encoding: { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] },
      filters: [],
      mark: { category: 'North' },
      page: { offset: 0, limit: 10 },
    });
    ok('a missing dataset returns ok:false, not an empty row set', res.ok === false && res.available === undefined);
  }
}

main()
  .then(() => {
    cleanup();
    if (failures > 0) {
      console.error(`\n${failures} check(s) failed`);
      process.exit(1);
    }
    console.log('\nAll visual:rows checks passed');
  })
  .catch((err) => {
    console.error('FAIL unexpected error', err);
    cleanup();
    process.exit(1);
  });
