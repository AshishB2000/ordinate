// Self-check for the formula editor's answer service: the SHIPPED
// `formula:check` handler (src/ipc/formula.ts), driven against a REAL saved
// dataset with electron stubbed — the test-columnProfile.ts pattern.
//
// It drives the handler rather than the helpers underneath it because every
// claim this file makes is a claim the EDITOR relies on, and the editor only
// ever sees what comes back over the channel. A test of the pieces would pass
// with the handler wired to the wrong dataset, the wrong column set, or a
// sample built from the source table instead of the prepared one.
//
// Three things are asserted, and they are the three the panel is made of:
//
//   1. ERROR POSITIONS. `at` must cover the text that is actually wrong —
//      asserted by slicing the expression with it, not by comparing numbers.
//      A test that asserted `{start: 10}` would pass on an off-by-one that
//      underlines the wrong character, which is the only bug an underline can
//      really have.
//   2. UNKNOWN COLUMNS, with the did-you-mean. An expression that COMPILES can
//      still reference a column that does not exist; the language degrades it
//      to null per row rather than failing, so this message is the only thing
//      standing between a typo and a column of silent nulls.
//   3. RESULT TYPE, one case per category, and the eight-row sample — whose
//      result is checked against the arithmetic recomputed here from the rows
//      that went in, never against numbers typed into this file.
//
// And one negative: CHECKING WRITES NOTHING. The record's pipeline and row
// count are read before and after, because a "preview" that quietly appended a
// step would be discovered by users, not by tests.
//
//   npm run build:ts && node scripts/test-formulaCheck.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-formula-'));

// ── The electron stub (test-columnProfile.ts pattern, plus handler capture) ──
const handlers = new Map<string, IpcHandler>();
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getVersion: () => '0.0.0-test' },
      ipcMain: {
        handle: (channel: string, fn: IpcHandler) => { handlers.set(channel, fn); },
        on: () => {},
      },
      dialog: {},
      net: {},
      nativeImage: {},
      shell: {},
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the REAL modules (built by pretest).
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const datasetsIpc: typeof import('../src/ipc/datasets') = require('../src/ipc/datasets');
const formulaIpc: typeof import('../src/ipc/formula') = require('../src/ipc/formula');

datasetsIpc.register(); // formula:check reads its sample through datasets.pageFor
formulaIpc.register();

/** Twelve rows, so the eight-row sample is genuinely a WINDOW and not the table. */
const ROWS: Array<[string, number, number, string]> = [
  ['north', 120, 4, '2026-01-05'],
  ['south', 340, 8, '2026-01-19'],
  ['north', 75, 3, '2026-02-02'],
  ['east', 900, 12, '2026-02-14'],
  ['west', 60, 5, '2026-03-01'],
  ['north', 410, 10, '2026-03-22'],
  ['south', 205, 41, '2026-04-07'],
  ['east', 33, 2, '2026-04-30'],
  ['west', 780, 15, '2026-05-11'],
  ['north', 95, 7, '2026-06-03'],
  ['south', 512, 16, '2026-06-28'],
  ['east', 148, 9, '2026-07-15'],
];

async function main(): Promise<void> {
  const check = handlers.get('formula:check');
  const functions = handlers.get('formula:functions');
  if (!check || !functions) {
    ok('formula IPC registered both handlers', false, [...handlers.keys()].join(', '));
    return;
  }
  ok('formula IPC registered both handlers', true);

  await projects.init();
  await datasets.init();
  const proj = await projects.createProject('formula');
  const ds = await datasets.saveDataset(proj.id, {
    name: 'Orders',
    sourceKind: 'csv',
    columns: [
      { name: 'region', type: 'text' },
      { name: 'revenue', type: 'number' },
      { name: 'units', type: 'number' },
      { name: 'ordered_at', type: 'date' },
    ],
    rows: ROWS.map((r) => r.slice()) as any,
  });
  ok('seeded a dataset to check against', Boolean(ds && ds.id));
  if (!ds) return;

  const ask = (expression: string): Promise<any> =>
    check(null, { projectId: proj.id, datasetId: ds.id, expression });

  // ── 1. Error positions ─────────────────────────────────────────────────────
  // Each case names the text the underline MUST cover. Asserting the slice
  // rather than the offsets is what makes an off-by-one fail: the numbers can
  // be wrong in a way that still "looks like" a position.
  const badCases: Array<{ expr: string; underlines: string; because: string }> = [
    { expr: '[revenue] /', underlines: '/', because: 'a trailing operator' },
    // The SAME mistake with the finger still on the space bar. Both must mark
    // the operator, not the whitespace after it.
    { expr: '[revenue] / ', underlines: '/', because: 'a trailing operator, then a space' },
    { expr: 'round([revenue], 2', underlines: '2', because: 'an unclosed call' },
    { expr: 'nosuchfn([revenue])', underlines: 'nosuchfn', because: 'an unknown function' },
    // A TOKENIZER failure, which carries its own offsets rather than a token
    // index — the other half of the position plumbing.
    { expr: '[revenue] ~ [units]', underlines: '~', because: 'a character the language has no use for' },
  ];
  for (const c of badCases) {
    const res = await ask(c.expr);
    ok(`rejects ${c.because}`, res.ok === false && typeof res.error === 'string' && res.error.length > 0,
      JSON.stringify(res.error));
    const slice = res.at ? c.expr.slice(res.at.start, res.at.end) : '(no position)';
    ok(`underlines "${c.underlines}" in ${JSON.stringify(c.expr)}`, slice === c.underlines,
      `got ${JSON.stringify(slice)} from ${JSON.stringify(res.at)}`);
  }

  // A failed check still hands back what it can — the editor keeps painting.
  const stillTokens = await ask('round([revenue], 2');
  ok('a failed check still returns tokens to colour', Array.isArray(stillTokens.tokens) && stillTokens.tokens.length > 0,
    String(stillTokens.tokens && stillTokens.tokens.length));

  // ── 2. Unknown columns, with the did-you-mean ──────────────────────────────
  const typo = await ask('[reveune] / [units]');
  ok('a typo still COMPILES (this language has no unknown-column error)', typo.ok === true, JSON.stringify(typo.error));
  ok('the typo is reported as an unknown column', typo.unknownRefs.length === 1 && typo.unknownRefs[0].name === 'reveune',
    JSON.stringify(typo.unknownRefs));
  ok('the unknown column suggests the real one', typo.unknownRefs[0] && typo.unknownRefs[0].didYouMean === 'revenue',
    JSON.stringify(typo.unknownRefs[0]));
  ok('the column that DOES exist is not reported', typo.refs.indexOf('units') >= 0
    && !typo.unknownRefs.some((u: any) => u.name === 'units'), JSON.stringify(typo.refs));

  // Wrong case is the other half of the same mistake: the lookup is
  // case-sensitive, so `[Revenue]` is unknown — and obviously fixable.
  const wrongCase = await ask('[Revenue] + 1');
  ok('a case mismatch suggests the real column',
    wrongCase.unknownRefs.length === 1 && wrongCase.unknownRefs[0].didYouMean === 'revenue',
    JSON.stringify(wrongCase.unknownRefs));

  // Nothing near enough gets NO suggestion. A "did you mean" that fires on
  // anything teaches the user to ignore it.
  const farOff = await ask('[xyzzy] + 1');
  ok('a name near nothing gets no suggestion',
    farOff.unknownRefs.length === 1 && farOff.unknownRefs[0].didYouMean === undefined,
    JSON.stringify(farOff.unknownRefs));

  // A correct expression reports no unknowns at all.
  const clean = await ask('[revenue] / [units]');
  ok('a correct expression has no unknown columns', clean.ok === true && clean.unknownRefs.length === 0,
    JSON.stringify(clean.unknownRefs));

  // ── 3. Result type, one case per category ──────────────────────────────────
  const typeCases: Array<[string, string]> = [
    ['[revenue] / [units]', 'number'],
    ['upper([region])', 'string'],
    ['datetrunc("month", [ordered_at])', 'date'],
    ['[revenue] > 100', 'logical'],
    // A conversion lands in the type it PRODUCES, not in a "conversion" bucket.
    // `str([revenue])` is the surprising one and it is pinned DELIBERATELY: it
    // yields the strings "120", "340", … and the badge says `number`, because
    // `transforms.retypeColumn` runs the very same `detectColumnType` over the
    // very same strings when the step is saved and types that column `number`.
    // The badge's promise is "this is the column you will get", so agreeing
    // with the sniffer matters more here than agreeing with the function name.
    ['str([revenue])', 'number'],
    // …and a conversion whose output is NOT number-shaped stays text, which is
    // what stops the line above from being read as "str() is always number".
    ['str([region])', 'string'],
  ];
  for (const [expr, want] of typeCases) {
    const res = await ask(expr);
    ok(`${JSON.stringify(expr)} is typed ${want}`, res.ok === true && res.resultType === want,
      `${res.resultType} (${res.error || 'no error'})`);
  }

  // ── 4. The sample ──────────────────────────────────────────────────────────
  const sample = clean.sample;
  ok('the sample is the first eight rows', sample.rows.length === 8, String(sample.rows.length));
  ok('the sample carries one column per referenced input',
    sample.columns.join(',') === 'revenue,units', sample.columns.join(','));

  // The results are compared against the arithmetic recomputed from the rows
  // that went in — never against numbers written into this file, which would
  // only assert that someone once ran it.
  let wrongResult = 0;
  let wrongInputs = 0;
  for (let i = 0; i < sample.rows.length; i += 1) {
    const [, revenue, units] = ROWS[i];
    const row = sample.rows[i];
    if (!Object.is(row.result, revenue / units)) wrongResult++;
    if (row.inputs[0] !== revenue || row.inputs[1] !== units) wrongInputs++;
  }
  ok('every sampled result equals revenue ÷ units for that row', wrongResult === 0, wrongResult + ' wrong');
  ok('every sampled input is that row’s real value', wrongInputs === 0, wrongInputs + ' wrong');

  // A row-level failure degrades to null rather than throwing — and the panel
  // has to be able to SHOW that, which means null has to survive the channel.
  const textMath = await ask('[region] / [units]');
  ok('arithmetic on a text column samples as null',
    textMath.ok === true && textMath.sample.rows.every((r: any) => r.result === null),
    JSON.stringify(textMath.sample.rows.slice(0, 2)));
  ok('…and therefore has no result type', textMath.resultType === null, String(textMath.resultType));

  // ── 5. Checking writes NOTHING ─────────────────────────────────────────────
  const after = await datasets.getDatasetMeta(proj.id, ds.id);
  ok('checking added no pipeline step', Boolean(after) && (after!.steps || []).length === 0,
    JSON.stringify(after && after.steps));
  ok('checking changed no rows', Boolean(after) && after!.rowCount === ROWS.length,
    String(after && after.rowCount));
  ok('checking changed no columns', Boolean(after) && after!.columns.length === 4,
    String(after && after.columns.length));

  // ── 6. The catalog channel ─────────────────────────────────────────────────
  const cat = await functions(null);
  ok('formula:functions returns the catalog', Array.isArray(cat) && cat.length > 50, String(cat && cat.length));
  ok('each catalog row has what the list renders',
    Array.isArray(cat) && cat.every((d: any) => d.name && d.signature && d.summary && d.category));

  // ── 7. The trust boundary ──────────────────────────────────────────────────
  const huge = await ask('1 + '.repeat(2000) + '1');
  ok('an over-long expression is refused, not run', huge.ok === false && /too long/i.test(huge.error || ''),
    JSON.stringify(huge.error));
  const nonsense = await check(null, {});
  ok('a call with no arguments answers rather than throwing', nonsense && nonsense.ok === false,
    JSON.stringify(nonsense && nonsense.error));
}

main()
  .catch((err) => { ok('suite ran without throwing', false, err && err.stack); })
  .finally(() => {
    Module._load = origLoad;
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    process.exit(failureCount() ? 1 : 0);
  });
