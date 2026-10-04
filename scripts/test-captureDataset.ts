// Self-check for the Week 13 capture → dataset bridge (src/captureDataset.ts,
// PURE) plus the datasets.ts screenshot-link + replace/append persistence. Like
// test-datasets.ts, the 'electron' module is stubbed (via Module._load) so
// userData points at a fresh temp dir, then the REAL datasets + projects modules
// run against real disk. The pure bridge needs no stub. No framework.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-capds-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: (_name: string) => tmpUserData } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled siblings.
const cd: typeof import('../src/data/captureDataset') = require('../src/data/captureDataset');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');


// A realistic extractedTable (object-keyed rows, columns with id/label/model-type).
function sampleExtraction(): any {
  return {
    columns: [
      { id: 'c1', label: 'City', role: 'category', type: 'text' },
      { id: 'c2', label: 'Revenue', role: 'value', type: 'number' },
    ],
    rows: [
      { c1: 'Paris', c2: 1200 },
      { c1: 'Berlin', c2: 3400 },
    ],
  };
}

async function main(): Promise<void> {
  // ── toBody ────────────────────────────────────────────────────────────────
  const tb = cd.toBody(sampleExtraction());
  ok('toBody header uses labels', JSON.stringify(tb.header) === JSON.stringify(['City', 'Revenue']));
  ok('toBody projects object rows into column order', tb.body[0][0] === 'Paris' && tb.body[0][1] === '1200');

  const tbMissing = cd.toBody({
    columns: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
    rows: [{ a: 'x', c: 'z', extra: 'ignored' }], // missing b, an extra key
  });
  ok('toBody missing key → empty string', tbMissing.body[0][1] === '');
  ok('toBody keeps present cells around a missing one', tbMissing.body[0][0] === 'x' && tbMissing.body[0][2] === 'z');
  ok('toBody rows are rectangular to column width', tbMissing.body[0].length === 3);
  ok('toBody ignores extra keys', tbMissing.body[0].length === 3);

  const tbNull = cd.toBody({ columns: [{ id: 'a', label: 'A' }], rows: [{ a: null }] });
  ok('toBody null cell → empty string', tbNull.body[0][0] === '');

  const tbEmptyCols = cd.toBody({ columns: [], rows: [{ a: 1 }] });
  ok('toBody empty columns → empty header+body', tbEmptyCols.header.length === 0 && tbEmptyCols.body.length === 0);

  const tbFallback = cd.toBody({ columns: [{ id: 'onlyId' }], rows: [{ onlyId: 5 }] });
  ok('toBody label falls back to id', tbFallback.header[0] === 'onlyId');

  // ── extractedTableToTable / buildDraft: strict number rule + warnings ────────
  const draft = cd.extractedTableToTable(sampleExtraction());
  ok('buildDraft detects a text column', draft.columns[0].type === 'text');
  ok('buildDraft detects a real number column (strict rule)', draft.columns[1].type === 'number');
  ok('buildDraft coerces numeric cells to JS numbers', draft.rows[0][1] === 1200);
  ok('buildDraft is aliased to extractedTableToTable', cd.buildDraft === cd.extractedTableToTable);

  // Leading-zero column must STAY text even though the model may hint "number".
  const zeroDraft = cd.extractedTableToTable({
    columns: [{ id: 'code', label: 'Code', type: 'number' }, { id: 'big', label: 'Big', type: 'number' }],
    rows: [
      { code: '007', big: '12345678901234567890' },
      { code: '012', big: '99999999999999999999' },
    ],
  });
  ok('buildDraft: leading-zero column stays text (identifier safety)', zeroDraft.columns[0].type === 'text');
  ok('buildDraft: leading-zero cell kept verbatim ("007")', zeroDraft.rows[0][0] === '007');
  ok('buildDraft: >15-digit column stays text (precision safety)', zeroDraft.columns[1].type === 'text');

  // Empty extraction → a "No rows found" warning (surfaced from finalize).
  const emptyDraft = cd.extractedTableToTable({ columns: [{ id: 'a', label: 'A' }], rows: [] });
  ok('buildDraft: empty rows → "No rows found" warning', emptyDraft.warnings.some((w) => /No rows found/i.test(w)));

  // A ragged extraction (rows with missing/extra keys) normalizes to a rectangular
  // table — no data corruption, empty cells for the gaps.
  const raggedDraft = cd.extractedTableToTable({
    columns: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    rows: [{ a: '1', b: '2' }, { a: '3' }, { a: '5', b: '6', junk: 'x' }],
  });
  ok('buildDraft: ragged extraction padded to full width', raggedDraft.rows.every((r) => r.length === 2));
  ok('buildDraft: ragged missing cell filled null', raggedDraft.rows[1][1] === null);

  // A screenshot-of-a-table shape round-trips to a clean typed table.
  const roundTrip = cd.extractedTableToTable({
    columns: [
      { id: 'q', label: 'Quarter', type: 'text' },
      { id: 'v', label: 'Sales', type: 'number' },
    ],
    rows: [{ q: 'Q1', v: '100' }, { q: 'Q2', v: '250' }, { q: 'Q3', v: '175' }],
  });
  ok('buildDraft: table screenshot round-trips (3 rows)', roundTrip.rowCount === 3);
  ok('buildDraft: round-trip typed the value column number', roundTrip.columns[1].type === 'number' && roundTrip.rows[1][1] === 250);

  // ── coerceFinal: user type choice WINS ──────────────────────────────────────
  const cfCols = [
    { name: 'label', type: 'text' as const },
    { name: 'amount', type: 'number' as const },
  ];
  const cfBody = [['a', '10'], ['b', 'oops'], ['c', '20']];
  const cf = cd.coerceFinal(cfCols, cfBody);
  ok('coerceFinal: numeric cell coerces to number', cf.rows[0][1] === 10);
  ok('coerceFinal: non-numeric in a number column → null (never NaN)', cf.rows[1][1] === null);
  ok('coerceFinal: warns about the nulled non-numeric value', cf.warnings.some((w) => /amount/.test(w) && /1/.test(w)));

  const cfText = cd.coerceFinal([{ name: 'n', type: 'text' as const }], [['10'], ['20']]);
  ok('coerceFinal: number→text keeps the digits', cfText.rows[0][0] === '10' && cfText.warnings.length === 0);

  const cfDate = cd.coerceFinal([{ name: 'd', type: 'date' as const }], [['2024-01-05']]);
  ok('coerceFinal: a date stays a string', cfDate.rows[0][0] === '2024-01-05');

  // ── alignForAppend ──────────────────────────────────────────────────────────
  const existingCols = [
    { name: 'City', type: 'text' as const },
    { name: 'Revenue', type: 'number' as const },
  ];
  // Incoming columns in a DIFFERENT order + one unmatched extra; match by name.
  const incomingCols = [
    { name: 'revenue', type: 'text' as const }, // case-insensitive match, different order
    { name: 'City', type: 'text' as const },
    { name: 'Notes', type: 'text' as const },   // unmatched → dropped
  ];
  const incomingBody = [['500', 'Rome', 'n/a'], ['700', 'Oslo', 'ok']];
  const al = cd.alignForAppend(existingCols, incomingCols, incomingBody);
  ok('alignForAppend: reorders incoming into existing column order', al.rows[0][0] === 'Rome' && al.rows[0][1] === 500);
  ok('alignForAppend: coerces to the EXISTING column type (Revenue→number)', al.rows[1][1] === 700);
  ok('alignForAppend: warns about a dropped unmatched incoming column', al.warnings.some((w) => /Notes/.test(w)));

  // An existing column with no incoming match → filled empty + warned.
  const al2 = cd.alignForAppend(
    [{ name: 'City', type: 'text' as const }, { name: 'Region', type: 'text' as const }],
    [{ name: 'City', type: 'text' as const }],
    [['Paris']],
  );
  ok('alignForAppend: unmatched existing column filled null', al2.rows[0][1] === null);
  ok('alignForAppend: warns about the unmatched existing column', al2.warnings.some((w) => /Region/.test(w)));

  // ── datasets.ts: capture link persistence + replace + append + guards ────────
  await projects.init();
  await datasets.init();
  const proj = await projects.createProject('Capture project');

  const saved = await datasets.saveDataset(proj.id, {
    name: 'Q3 revenue',
    sourceKind: 'capture',
    columns: draft.columns,
    rows: draft.rows,
    capture: { entryId: 'entry-1', cropPath: '/tmp/history/entry-1/crop.png' },
  });
  ok('saveDataset: accepts sourceKind "capture"', saved !== null && saved.sourceKind === 'capture');
  ok('saveDataset: stores the screenshot link', saved !== null && saved.capture?.cropPath === '/tmp/history/entry-1/crop.png');
  const dsId = saved !== null ? saved.id : '';

  // Reload → capture link survives.
  const reloaded = await datasets.getDataset(proj.id, dsId);
  ok('capture link survives a reload', reloaded !== null && reloaded.capture?.entryId === 'entry-1');

  // listDatasets summary carries the crop path (thumbnail without a full load).
  const list = await datasets.listDatasets(proj.id);
  const summ = list.find((d) => d.id === dsId);
  ok('listDatasets summary carries the capture crop path', !!summ && !!summ.capture && 'cropPath' in summ.capture && summ.capture.cropPath === '/tmp/history/entry-1/crop.png');
  ok('listDatasets summary carries sourceKind "capture"', !!summ && summ.sourceKind === 'capture');

  // REPLACE: swap rows + newest screenshot link wins.
  const replacementDraft = cd.extractedTableToTable({
    columns: [{ id: 'c1', label: 'City' }, { id: 'c2', label: 'Revenue' }],
    rows: [{ c1: 'Tokyo', c2: '9999' }],
  });
  await new Promise((r) => setTimeout(r, 5));
  const replaced = await datasets.updateDatasetData(
    proj.id, dsId,
    { columns: replacementDraft.columns, rows: replacementDraft.rows },
    { entryId: 'entry-2', cropPath: '/tmp/history/entry-2/crop.png' },
  );
  ok('replace: rows swapped to the new capture', replaced !== null && replaced.rowCount === 1 && replaced.rows[0][0] === 'Tokyo');
  ok('replace: newest screenshot link wins', replaced !== null && replaced.capture?.cropPath === '/tmp/history/entry-2/crop.png');
  const reReplaced = await datasets.getDataset(proj.id, dsId);
  ok('replace: swap + new link survive a reload', reReplaced !== null && reReplaced.rows[0][0] === 'Tokyo' && reReplaced.capture?.entryId === 'entry-2');

  // APPEND: align onto existing columns, concatenate, persist.
  const target = await datasets.getDataset(proj.id, dsId);
  const appendDraft = cd.extractedTableToTable({
    columns: [{ id: 'x', label: 'Revenue' }, { id: 'y', label: 'City' }], // reversed
    rows: [{ x: '4444', y: 'Cairo' }],
  });
  const appendBody = cd.toBody({
    columns: [{ id: 'x', label: 'Revenue' }, { id: 'y', label: 'City' }],
    rows: [{ x: '4444', y: 'Cairo' }],
  }).body;
  const aligned = cd.alignForAppend(target!.columns, appendDraft.columns, appendBody);
  const appended = await datasets.updateDatasetData(
    proj.id, dsId,
    { columns: target!.columns, rows: target!.rows.concat(aligned.rows) },
    { entryId: 'entry-3', cropPath: '/tmp/history/entry-3/crop.png' },
  );
  ok('append: row count grows by the aligned rows', appended !== null && appended.rowCount === 2);
  ok('append: aligned row lands in existing column order', appended !== null && appended.rows[1][0] === 'Cairo' && appended.rows[1][1] === 4444);
  ok('append: newest link wins again', appended !== null && appended.capture?.entryId === 'entry-3');

  // Preserve link when updateDatasetData is called WITHOUT a capture arg.
  const noCap = await datasets.updateDatasetData(proj.id, dsId, { columns: appended!.columns, rows: appended!.rows });
  ok('updateDatasetData: omitting capture preserves the stored link', noCap !== null && noCap.capture?.entryId === 'entry-3');

  // DUAL-UUID GUARD still holds on the new capture path.
  ok('guard: updateDatasetData rejects a traversal projectId',
    (await datasets.updateDatasetData('..', dsId, { columns: [], rows: [] }, { entryId: 'x', cropPath: 'y' })) === null);
  ok('guard: updateDatasetData rejects a traversal datasetId',
    (await datasets.updateDatasetData(proj.id, '../SECRET', { columns: [], rows: [] })) === null);
  ok('guard: saveDataset(capture) rejects a nonexistent parent project',
    (await datasets.saveDataset('00000000-0000-0000-0000-000000000000', {
      name: 'x', sourceKind: 'capture', columns: [], rows: [], capture: { entryId: 'e', cropPath: 'p' },
    })) === null);
}

main()
  .then(() => {
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) {}
    Module._load = origLoad;
    if (failureCount()) { console.error('\n' + failureCount() + ' captureDataset check(s) FAILED'); process.exit(1); }
    console.log('\nAll captureDataset checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
