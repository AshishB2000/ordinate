// The column profile's Text section and the text IPC, held to their references:
//
//   1. DIFFERENTIAL: engine/textSampleResident (the first N filled values off
//      the stored Parquet) against analysis/text/textProfile.textSampleOf (the
//      same walk over the hydrated rows) — value by value with Object.is, over
//      the cells that break naive code: whitespace-only (tab, NBSP, em space),
//      '', null, a leading U+FEFF, '007', Unicode, and enough rows that order
//      is not an accident. Then the whole profile computed from each sample.
//   2. The SHIPPED `text:profile` handler (electron stubbed), with
//      datasets.getDataset SPIED: the resident path must answer without
//      hydrating the table, and a number column must be refused by its schema
//      alone.
//   3. `text:preview` and `text:commitStep` — a small table saves directly; a
//      big one runs its per-row work as a `compute` job, and the fold then
//      re-scores nothing (vader.compoundScore spied).
//
//   npm run build:ts && node scripts/test-textProfile.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

type Cell = import('../src/data/transforms').Cell;
type ParsedColumn = import('../src/data/parse').ParsedColumn;
type IpcHandler = (event: unknown, payload?: unknown) => Promise<any>;

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-textprofile-'));
// Handlers land in the RPC registry (src/ipc/bus.ts outside Electron), not the stub.
const handlers: Map<string, IpcHandler> = require('../src/server/rpc').handlers;
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return {
      app: { getPath: (_name: string) => tmpUserData, getVersion: () => '0.0.0-test' },
      BrowserWindow: { getAllWindows: () => [] },
      dialog: {}, net: {}, nativeImage: {}, shell: {}, Notification: function () { return { show() {} }; },
    };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings of the REAL modules (built by pretest).
const pqSync: typeof import('../src/engine/parquetStoreSync') = require('../src/engine/parquetStoreSync');
const resident: typeof import('../src/engine/textSampleResident') = require('../src/engine/textSampleResident');
const tp: typeof import('../src/analysis/text/textProfile') = require('../src/analysis/text/textProfile');
const statsResident: typeof import('../src/engine/statsResident') = require('../src/engine/statsResident');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const jobs: typeof import('../src/app/jobs') = require('../src/app/jobs');
const textIpc: typeof import('../src/ipc/text') = require('../src/ipc/text');
const vaderMod = require('../src/analysis/text/vader');

textIpc.register();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-textprofile-fx-'));
let seq = 0;
const fixtureFile = (): string => path.join(tmpDir, `f${++seq}.parquet`);
const T = (name: string): ParsedColumn => ({ name, type: 'text' });
const N = (name: string): ParsedColumn => ({ name, type: 'number' });

function sameList(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
}

async function main(): Promise<void> {
  await projects.init();
  await datasets.init();
  if (!statsResident.isStatsResident()) {
    console.log('#    DuckDB bridge UNAVAILABLE — the JS path is always used; nothing resident to test');
    return;
  }

  // ── 1. The sample: resident vs the JS reference ────────────────────────────
  const tricky: Cell[][] = [
    ['a', null], ['b', ''], ['c', '   '], ['d', '\t'], ['e', ' '], ['f', '  　'],
    ['g', '﻿Starts with a BOM and is long enough'], ['h', '007'], ['i', 'Café naïve — “quotes” 😀'],
    ['j', '  padded but real  '], ['k', 'line\nbreak'], ['l', "don't stop"],
  ];
  const many: Cell[][] = [];
  for (let i = 0; i < 3000; i += 1) many.push([String(i % 7), i % 11 === 0 ? '' : `review number ${i} was ${i % 3 ? 'great' : 'slow'}`]);
  const cases: Array<{ label: string; columns: ParsedColumn[]; rows: Cell[][]; column: string; limit: number }> = [
    { label: 'tricky cells', columns: [T('k'), T('v')], rows: tricky, column: 'v', limit: 50 },
    { label: 'limit below the filled count', columns: [T('k'), T('v')], rows: tricky, column: 'v', limit: 3 },
    { label: 'limit 0', columns: [T('k'), T('v')], rows: tricky, column: 'v', limit: 0 },
    { label: '3,000 rows, first 1,000 filled in row order', columns: [T('k'), T('v')], rows: many, column: 'v', limit: 1000 },
    { label: 'first column (positional c0)', columns: [T('v'), T('k')], rows: tricky.map((r) => [r[1], r[0]]), column: 'v', limit: 50 },
    { label: 'no rows', columns: [T('v')], rows: [], column: 'v', limit: 10 },
  ];
  for (const c of cases) {
    const file = fixtureFile();
    pqSync.writeTable(file, c.columns, c.rows);
    const back = pqSync.readTable(file, c.columns);
    ok(`${c.label}: fixture reads back`, !!back);
    if (!back) continue;
    const want = tp.textSampleOf(c.columns, back.rows, c.column, c.limit);
    const got = await resident.textSampleResident({ parquetPath: file, columns: c.columns }, c.column, c.limit);
    ok(`${c.label}: resident answered`, got !== null);
    ok(`${c.label}: resident sample === JS sample, value by value (${want ? want.length : 'null'})`, sameList(want, got),
      JSON.stringify({ want: want && want.slice(0, 4), got: got && got.slice(0, 4) }));
    if (want && got) {
      ok(`${c.label}: the profile of each sample is identical`, JSON.stringify(tp.profileText(want)) === JSON.stringify(tp.profileText(got)));
    }
  }
  {
    const file = fixtureFile();
    const cols = [T('k'), N('n')];
    pqSync.writeTable(file, cols, [['a', 7], ['b', 8]]);
    ok('a NUMBER column: JS reference answers null', tp.textSampleOf(cols, [['a', 7]], 'n', 10) === null);
    ok('…and the resident path falls back (null), never casting', (await resident.textSampleResident({ parquetPath: file, columns: cols }, 'n', 10)) === null);
    ok('an unknown column: both null', tp.textSampleOf(cols, [], 'zz', 10) === null
      && (await resident.textSampleResident({ parquetPath: file, columns: cols }, 'zz', 10)) === null);
  }

  // ── 2. The shipped text:profile handler, never hydrating ───────────────────
  const profileH = handlers.get('text:profile');
  ok('text:profile is registered', typeof profileH === 'function');
  const proj = await projects.createProject('text');
  const reviews = [
    'The staff were friendly and the service was great', 'Terrible service, the delivery was late again',
    'Great value for the price, would recommend to friends', 'The box arrived damaged and support never replied',
    'Friendly staff, great food, slow delivery though', 'Refund took three weeks, terrible customer support',
  ];
  const rows: Cell[][] = [];
  for (let i = 0; i < 60; i += 1) rows.push(['r' + (i % 3), reviews[i % reviews.length], i, i % 2 ? 'North' : 'South']);
  const ds = await datasets.saveDataset(proj.id, { name: 'Reviews', sourceKind: 'csv',
    columns: [T('region'), T('review'), N('n'), T('short')], rows });
  ok('fixture dataset saved', !!(ds && ds.id));
  if (typeof profileH === 'function' && ds) {
    const realGet = datasets.getDataset;
    let hydrated = 0;
    (datasets as any).getDataset = async (...args: any[]): Promise<any> => { hydrated += 1; return (realGet as any)(...args); };
    try {
      const res = await profileH({}, { projectId: proj.id, datasetId: ds.id, column: 'review' });
      const want = tp.profileText(tp.textSampleOf(ds.columns, rows, 'review', tp.TEXT_SAMPLE_CAP) as string[]);
      ok('text:profile answers with the profile', !!(res && res.ok && res.profile), JSON.stringify(res).slice(0, 200));
      ok('text:profile === profileText(JS sample) — every figure', JSON.stringify(res.profile) === JSON.stringify(want));
      ok('text:profile never hydrated the table', hydrated === 0, `getDataset called ${hydrated}x`);
      ok('long reviews are eligible, English, with terms and a sentiment spread',
        res.profile.eligible && res.profile.lang === 'en' && res.profile.topTerms.length > 0 && res.profile.sentiment
        && res.profile.sentiment.bands.reduce((a: number, b: any) => a + b.count, 0) === 60);
      hydrated = 0;
      const short = await profileH({}, { projectId: proj.id, datasetId: ds.id, column: 'short' });
      ok('a text column of short labels is NOT eligible (no section)', short.ok && short.profile && short.profile.eligible === false
        && short.profile.topTerms.length === 0 && hydrated === 0);
      const num = await profileH({}, { projectId: proj.id, datasetId: ds.id, column: 'n' });
      ok('a number column: { profile: null } from the schema alone, no hydration', num.ok && num.profile === null && hydrated === 0, `hydrated=${hydrated}`);
      const es = await profileH({}, { projectId: proj.id, datasetId: ds.id, column: 'review', lang: 'es' });
      ok('a language override recounts with that list, and says what was detected', es.profile.lang === 'es' && es.profile.detected === 'en');
    } finally {
      (datasets as any).getDataset = realGet;
    }

    // ── 3. preview and commit, small table ───────────────────────────────────
    const previewH = handlers.get('text:preview') as IpcHandler;
    const commitH = handlers.get('text:commitStep') as IpcHandler;
    const pv = await previewH({}, { projectId: proj.id, datasetId: ds.id, index: -1,
      step: { type: 'keyword_rules', column: 'review', rules: [{ pattern: 'delivery', category: 'Delivery', match: 'word' }], otherwise: 'Other' } });
    ok('text:preview counts rows per category, rule order first, the default last',
      pv.ok && JSON.stringify(pv.categories) === JSON.stringify([{ category: 'Delivery', count: 20, isDefault: false }, { category: 'Other', count: 40, isDefault: true }]),
      JSON.stringify(pv.categories));
    const bad = await previewH({}, { projectId: proj.id, datasetId: ds.id, index: -1, step: { type: 'text_terms', column: 'review', lang: 'klingon' } });
    ok('text:preview refuses a malformed step with its reason', bad.ok === false && /language/.test(bad.error));
    const saved = await commitH({}, { projectId: proj.id, datasetId: ds.id, index: -1, step: { type: 'text_sentiment', column: 'review' } });
    const ci = saved.preview ? saved.preview.columns.findIndex((c: any) => c.name === 'review_sentiment') : -1;
    ok('text:commitStep (small) saves directly: the step is stored with its lexicon version',
      saved.ok && saved.dataset.steps.length === 1 && saved.dataset.steps[0].lexiconVersion === 'vaderSentiment 3.3.2');
    ok('…and the new column holds vader.compoundScore per row',
      ci >= 0 && saved.preview.rows.every((r: any[], i: number) => Object.is(r[ci], vaderMod.compoundScore(String(rows[i][1])))));
  }

  // ── 3b. commit on a big table: a compute job, then a fold that re-scores nothing ──
  {
    const big: Cell[][] = [];
    for (let i = 0; i < textIpc.JOB_MIN_ROWS; i += 1) big.push([reviews[i % reviews.length] + ' #' + (i % 97)]);
    const bds = await datasets.saveDataset(proj.id, { name: 'Big reviews', sourceKind: 'csv', columns: [T('review')], rows: big });
    ok('big fixture saved', !!(bds && bds.id));
    if (bds) {
      const real = vaderMod.compoundScore;
      let calls = 0;
      vaderMod.compoundScore = (s: string) => { calls += 1; return real(s); };
      const seen: string[] = [];
      const off = jobs.onChange((snap) => { for (const j of snap.active) if (!seen.includes(j.kind)) seen.push(j.kind); });
      try {
        const res = await (handlers.get('text:commitStep') as IpcHandler)({}, { projectId: proj.id, datasetId: bds.id, index: -1, step: { type: 'text_sentiment', column: 'review' } });
        ok('big commit saved the step', !!(res && res.ok && res.dataset.steps.length === 1), JSON.stringify(res && res.error));
        ok('…through a compute job', seen.includes('compute'), seen.join(','));
        const done = jobs.snapshot().recent.find((j) => j.kind === 'compute');
        ok('…which finished done, at full progress', !!done && done.state === 'done' && done.progress === 1, JSON.stringify(done));
        ok('…and every row was scored exactly ONCE (the job; the fold took it warm)', calls === big.length, `calls=${calls} rows=${big.length}`);
        const ci = res.preview.columns.findIndex((c: any) => c.name === 'review_sentiment');
        ok('…with the same scores as scoring each row directly', ci >= 0 && [0, 1, 5000, big.length - 1]
          .every((i) => Object.is(res.preview.rows[i][ci], real(String(big[i][0])))));
      } finally {
        off();
        vaderMod.compoundScore = real;
      }
    }
  }
}

void main()
  .catch((err) => { ok('unexpected error', false, err && err.stack ? err.stack : err); })
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' text-profile check(s) FAILED'); process.exit(1); }
    console.log('\nAll text-profile checks passed.');
    process.exit(0); // the DuckDB worker keeps the loop alive otherwise
  });
