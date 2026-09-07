// A saved visual keeps the chart type its author chose — launches the REAL app.
//
// WHY THIS FILE EXISTS. Opening a saved GAUGE drew a column chart, and saving
// again wrote `column` to disk. That is not a rendering glitch, it is silent
// DATA LOSS: the type the user picked was gone, and nothing said so.
//
// The pure rule is pinned in scripts/test-chartCanRender.ts. This file pins the
// consequence, which is the half that unit test cannot see: the builder's
// restore path (openSavedVisual -> recomputeVisual -> buildVizPicker's initial
// selection -> onSelect writing `vizCurrentChartType`) and then what the NEXT
// save actually puts on disk. Every hop there is a bare global resolved at call
// time, so a rename anywhere along it breaks this silently.
//
// GAUGE IS THE CASE THAT BROKE, and it is the interesting one because it is not
// in `recommended` for a categorical encoding — it survives reopening only if
// the restore gate asks "can it draw" rather than "is it suggested".
//
//   npm run build:ts && node scripts/smoke-saved-chart-type.js

export {}; // module scope — sibling smoke scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { launchSmoke, seedProject, openProject } from './smokeFixture';

async function main(): Promise<void> {
  const s = await launchSmoke('savedtype');
  const { win, app, errors } = s;

  // 2000 rows, not the default million: nothing here asserts on row count, and
  // the seven `region` values plus one numeric `amount` are exactly the
  // categorical, single-measure shape a gauge is NOT recommended for.
  const fixture = await seedProject(app, { rows: 2000 });
  ok('seeded a project and its categorical dataset',
    Boolean(fixture.projectId && fixture.datasetId));

  const ENCODING = { category: 'region', values: [{ column: 'amount', aggregation: 'sum' }] };

  // Save a GAUGE over that categorical encoding, through the real IPC — the same
  // channel the builder's Save button uses.
  const saved: any = await win.evaluate(async (f: any) => {
    const res = await (window as any).hub.saveVisual({
      projectId: f.projectId,
      datasetId: f.datasetId,
      name: 'Amount gauge',
      chartType: 'gauge',
      encoding: f.enc,
      overrides: {},
      filters: [],
    });
    return { id: res && res.id, ok: res && res.ok !== false };
  }, { ...fixture, enc: ENCODING });
  ok('a gauge saves over a categorical encoding', Boolean(saved.ok && saved.id), JSON.stringify(saved));

  const onDisk = async (): Promise<string> => win.evaluate(async (a: any) => {
    const v = await (window as any).hub.getVisual(a.pid, a.id);
    return v ? String(v.chartType) : '(missing)';
  }, { pid: fixture.projectId, id: saved.id });

  ok('…and is `gauge` on disk before anyone opens it', (await onDisk()) === 'gauge');

  // ── Reopen it in the builder. This is where it used to become a column. ──
  // Adopt the project first: openSavedVisual reads `currentProjectId`, and
  // without it the builder never loads and every assertion below reads a blank.
  await openProject(win, fixture.projectId);
  await win.waitForTimeout(1200);
  await win.evaluate(() => (window as any).selectSection('visuals'));
  await win.waitForTimeout(1500);
  await win.evaluate((id: string) => (window as any).openSavedVisual(id), saved.id);
  await win.waitForTimeout(4000);

  // `vizCurrentChartType` is a top-level `let` in a classic script — it is in the
  // global LEXICAL scope, NOT a property of `window`, so reading it off `window`
  // silently yields undefined. A string expression evaluates in page scope, where
  // the bare identifier resolves.
  const shown = await win.evaluate(`({
    current: vizCurrentChartType,
    chip: (document.querySelector('.cv-viz-chip.is-active') || {}).dataset?.type || '',
    canvases: document.querySelectorAll('#viz-builder canvas').length,
  })`) as any;
  ok('reopening a saved gauge still shows a GAUGE, not a column',
    shown.current === 'gauge', JSON.stringify(shown));
  ok('…and it actually drew', shown.canvases > 0, JSON.stringify(shown));

  // ── The half that loses work: save again and read the disk. ──────────────
  // Not through the Save button (it opens a name prompt); through the same IPC
  // the button calls, with the type the builder is currently holding. If the
  // restore clobbered it, this writes `column` over the user's gauge.
  // updateVisual, NOT saveVisual: that is the channel the Save button uses when
  // `vizEditingId` is set. An earlier draft of this file called saveVisual with
  // an `id`, which silently CREATED a second visual and then read the untouched
  // original back — the assertion passed with the bug present. Inert.
  const afterResave = await win.evaluate(async (a: any) => {
    await (window as any).hub.updateVisual(a.pid, a.id, {
      name: 'Amount gauge', chartType: a.type, encoding: a.enc, overrides: {}, filters: [],
    });
    const v = await (window as any).hub.getVisual(a.pid, a.id);
    return v ? String(v.chartType) : '(missing)';
  }, { pid: fixture.projectId, id: saved.id, enc: ENCODING,
       type: await win.evaluate('vizCurrentChartType') as string });
  ok('re-saving after a reopen does NOT downgrade the stored type to column',
    afterResave === 'gauge', afterResave);

  // ── A type that genuinely cannot draw must still fall back ──────────────
  // The fix restores what CAN render; it must not restore what cannot. A funnel
  // needs 3 labels and a heatmap needs 2 series — this data has 3 labels but one
  // series, so the heatmap is the honest "cannot draw" case.
  const heatmap: any = await win.evaluate(async (f: any) => {
    const res = await (window as any).hub.saveVisual({
      projectId: f.projectId, datasetId: f.datasetId, name: 'Impossible heatmap',
      chartType: 'heatmap',
      encoding: f.enc,
      overrides: {}, filters: [],
    });
    return { id: res && res.id };
  }, { ...fixture, enc: ENCODING });
  await win.evaluate((id: string) => (window as any).openSavedVisual(id), heatmap.id);
  await win.waitForTimeout(4000);
  const fellBack = await win.evaluate('vizCurrentChartType') as string;
  ok('a saved type that CANNOT draw this data still falls back to a drawable one',
    fellBack !== 'heatmap' && Boolean(fellBack), String(fellBack));

  ok('no renderer console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await s.close();
}

main()
  .then(() => {
    if (failureCount()) {
      console.error('\n' + failureCount() + ' saved-chart-type smoke check(s) FAILED');
      process.exit(1);
    }
    console.log('\nAll saved-chart-type smoke checks passed.');
  })
  .catch((err) => { console.error(err); process.exit(1); });
