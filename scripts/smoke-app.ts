// The data engine and the dataset store, on the REAL app.
//
// This file used to be the whole smoke suite in one 3,725-line run: one launch,
// one fixture, and every surface asserted in sequence off whatever state the
// previous surface happened to leave behind. That made it the largest file in
// the repo, and — worse — the file every OTHER smoke file exists to avoid
// growing: smoke-sample, smoke-dock, smoke-dockHero, smoke-composer and
// smoke-section-hero each open with a comment saying they are separate files
// BECAUSE this one could not take another line. One file was shaping the design
// of everything around it.
//
// It is now split by SURFACE, along its own section comments, into siblings that
// each launch their own app: smoke-shell (Home/Connect/Capture/nav),
// smoke-analysis-create (the wizard), smoke-analysis-workbench (the rail and
// direct manipulation), smoke-analysis-props (the gallery and Properties),
// smoke-dashboard-controls (control cards, Present, Export),
// smoke-draft-review (the AI draft dialog), smoke-viz-builder (the builder and
// the drill panel) and smoke-render-stacks (Chart.js / vgplot / MapLibre and
// the deferred export bundles). The launch and the fixture they share live in
// scripts/smokeFixture.ts; the assertions never do.
//
// What is LEFT here is the part that has no UI surface of its own: a real
// 1,000,000-row dataset written through the shipped save path, the resident
// (DuckDB-over-Parquet) query layer answering off it, and the dataset store's
// refresh chain — a file on disk changes and the rendered row count follows.
//
// Not part of `npm test` — it boots Electron and needs a display. Run it with
// `npm run smoke`; CI runs it as its own job under xvfb.

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { launchSmoke, reloadSmoke, seedProject, finishSmoke } from './smokeFixture';

const fs: typeof import('fs') = require('fs');

async function main(): Promise<void> {
  const smoke = await launchSmoke('app');
  const { app, win, errors } = smoke;

  ok('window opened', true, `title="${await win.title()}"`);

  const r = await seedProject(app, { rows: 1_000_000 });

  // Chart and metric go through the RESIDENT paths — what visual:data and
  // dashboard:metric actually use since Phase 2.5. At a million rows the old
  // hydrate-then-fold would dominate this test's runtime while exercising a
  // path the app no longer takes.
  const e: any = await app.evaluate(async (_electron, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const residentQuery = req('./src/engine/residentQuery.js');
    const datasetPage = req('./src/engine/datasetPage.js');
    const out: any = {};

    const src = await datasets.residentSource(arg.projectId, arg.datasetId);
    out.hasResidentSource = !!src;

    let t = Date.now();
    const agg = src && residentQuery.aggregateResident(src, 'region', [
      { column: 'amount', aggregation: 'sum' },
    ]);
    out.aggMs = Date.now() - t;
    out.labels = agg && agg.labels;
    out.seriesName = agg && agg.series[0] && agg.series[0].name;
    out.values = agg && agg.series[0] && agg.series[0].values;

    t = Date.now();
    out.metric = src && residentQuery.computeMetricResident(src, {
      column: 'amount',
      aggregation: 'sum',
    });
    out.metricMs = Date.now() - t;

    // ── An `in` filter, end to end, on a MILLION rows ───────────────────────
    //
    // The differential suites prove `in` is correct. What they cannot prove is
    // that the real CALL SITE still routes to SQL: an operator missing from a
    // resident module's vocabulary is SKIPPED, not failed — no WHERE is emitted
    // and the query happily answers over every row. So this asserts three
    // separate things, because any one of them alone can pass while broken:
    //   1. the chart returns only the 3 listed groups,
    //   2. the metric changes (a skipped predicate would return the full sum),
    //   3. residentTrace says 'resident', not 'skipped' or 'failed'.
    const trace = req('./src/engine/residentTrace.js');
    // visualsResident: moved out of ipc/visuals.js at the cap, still the SHIPPED helper.
    const ipcVisuals = req('./src/ipc/visualsResident.js');
    const inFilter = [{ type: 'filter', column: 'region', op: 'in', values: ['region0', 'region2', 'region4'] }];

    out.inChart = src && residentQuery.aggregateResident(src, 'region', [
      { column: 'amount', aggregation: 'sum' },
    ], inFilter);
    out.inLabels = out.inChart && out.inChart.labels;
    out.inMetric = src && residentQuery.computeMetricResident(
      src, { column: 'amount', aggregation: 'sum' }, inFilter,
    );
    out.notInMetric = src && residentQuery.computeMetricResident(
      src, { column: 'amount', aggregation: 'sum' },
      [{ type: 'filter', column: 'region', op: 'not in', values: ['region0', 'region2', 'region4'] }],
    );

    // Through the shipped IPC helper, which is what `visual:data` calls — and
    // therefore the thing that has to still choose the resident path.
    trace.reset();
    t = Date.now();
    const viaIpc = await ipcVisuals.residentVizData(arg.projectId, arg.datasetId, {
      category: 'region', values: [{ column: 'amount', aggregation: 'sum' }],
    }, inFilter);
    out.inIpcMs = Date.now() - t;
    out.inIpcLabels = viaIpc && viaIpc.data && viaIpc.data.labels;
    out.inIpcWarnings = viaIpc && viaIpc.warnings ? viaIpc.warnings.length : -1;
    out.inTrace = trace.snapshot().vizAggregate || null;

    // An `in` with NO values must be REJECTED by that helper, because the JS
    // path would emit a warning there and the fast path may only run when it
    // provably would not have.
    trace.reset();
    out.emptyInViaIpc = await ipcVisuals.residentVizData(arg.projectId, arg.datasetId, {
      category: 'region', values: [{ column: 'amount', aggregation: 'sum' }],
    }, [{ type: 'filter', column: 'region', op: 'in', values: [] }]);

    // One page of the Explore grid — the path that replaced holding the table.
    t = Date.now();
    const page = src && datasetPage.readPage(src, { offset: 0, limit: 500 });
    out.pageMs = Date.now() - t;
    out.pageRows = page && page.rows.length;
    out.pageTotal = page && page.total;
    out.skuSample = page ? page.rows.slice(0, 3).map((x: any[]) => x[1]) : [];
    out.skuTypes = page ? page.rows.slice(0, 3).map((x: any[]) => typeof x[1]) : [];
    return out;
  }, { projectId: r.projectId, datasetId: r.datasetId });

  ok('project created', !!r.projectId);
  ok('1,000,000-row dataset saved — the full cap, 20x the old one', r.rowCount === 1_000_000, `rowCount=${r.rowCount}`);
  ok('dataset is Parquet-backed', r.resident === true);
  ok('chart data computed', Array.isArray(e.labels) && e.labels.length === 7,
     `labels=${JSON.stringify(e.labels)}`);
  ok('series named by measureLabel', e.seriesName === 'sum of amount', `"${e.seriesName}"`);
  ok('chart values are JS numbers', e.values.every((v: unknown) => typeof v === 'number'),
     `first=${e.values[0]}, agg took ${e.aggMs} ms`);
  ok('metric card computed', typeof e.metric === 'number', `sum=${e.metric} in ${e.metricMs} ms`);
  ok('dataset exposes a resident source', e.hasResidentSource === true);
  ok('a file-backed dataset was imported with a file origin',
     r.fileDatasetRows === 2 && typeof r.csvPath === 'string', `${r.fileDatasetRows} rows from ${r.csvPath}`);

  // ── The `in` operator, on the real app, over a million rows ───────────────
  ok('an `in` filter with 3 values narrows the chart to those 3 groups',
     Array.isArray(e.inLabels) && e.inLabels.length === 3 &&
       JSON.stringify(e.inLabels) === JSON.stringify(['region0', 'region2', 'region4']),
     JSON.stringify(e.inLabels));
  // The proof the predicate REACHED SQL: a skipped operator would answer over
  // all 7 regions and hand back the unfiltered total.
  ok('…and the metric card respects it, rather than returning the full total',
     typeof e.inMetric === 'number' && e.inMetric !== e.metric,
     `filtered=${e.inMetric} vs unfiltered=${e.metric}`);
  ok('`in` and `not in` partition the column exactly',
     typeof e.notInMetric === 'number' && Math.abs((e.inMetric + e.notInMetric) - e.metric) < 1e-6,
     `${e.inMetric} + ${e.notInMetric} vs ${e.metric}`);
  ok('the same filter through the shipped visual:data helper agrees',
     JSON.stringify(e.inIpcLabels) === JSON.stringify(e.inLabels) && e.inIpcWarnings === 0,
     `labels=${JSON.stringify(e.inIpcLabels)} warnings=${e.inIpcWarnings}`);
  // residentTrace is the runtime alarm for a fast path that quietly stopped
  // firing. 'resident' means the SQL path answered; 'skipped'/'failed' would
  // both still produce a CORRECT chart, ~600x slower, and ship green.
  ok('…on the RESIDENT path — not skipped, not failed',
     !!e.inTrace && e.inTrace.resident === 1 && e.inTrace.skipped === 0 && e.inTrace.failed === 0,
     JSON.stringify(e.inTrace));
  ok('an `in` with no values falls back instead of silently dropping its warning',
     e.emptyInViaIpc === null, JSON.stringify(e.emptyInViaIpc));
  ok('`in` over 1M rows is still fast', e.inIpcMs < 2000, `${e.inIpcMs} ms`);
  ok('one Explore page read', e.pageRows === 500 && e.pageTotal === 1_000_000,
     `${e.pageRows} rows of ${e.pageTotal} in ${e.pageMs} ms`);
  // These are the numbers the whole migration exists to produce. Loose bounds —
  // a CI runner is slower than a dev machine — but a regression to seconds fails.
  ok('aggregate over 1M rows is fast', e.aggMs < 2000, `${e.aggMs} ms`);
  ok('page read over 1M rows is fast', e.pageMs < 2000, `${e.pageMs} ms`);
  ok('leading zeros stayed text',
     e.skuTypes.every((t: string) => t === 'string') && e.skuSample[0] === '000',
     JSON.stringify(e.skuSample));
  ok('visual saved', !!r.visualId);

  // Reload so the renderer picks up the project written above.
  await reloadSmoke(smoke);

  // Projects are no longer the front door — there is no card to click. Open the
  // project through openWorkspace(), the same renderer entry point the app uses
  // when a Recent item is opened, then navigate to Data via the sidebar nav.
  const opened: string | null = await win.evaluate((id) => {
    const ow = (window as any).openWorkspace;
    if (typeof ow !== 'function') return null;
    ow(id);
    return id;
  }, r.projectId);
  ok('project opens from the UI (openWorkspace)', opened !== null, opened || 'openWorkspace missing');
  await win.waitForTimeout(1500);

  // The "Data" nav item points at the dataset list now, so reach it the way a
  // user does — one click on the nav. What this proves (a stored Parquet dataset
  // renders with its real row count) is unchanged; only the route is more
  // faithful than the old direct selectSection() call.
  await win.click('.as-nav-item[data-section="datasets"]', { timeout: 8000 }).catch(() => {});
  await win.waitForTimeout(2000);

  // The dataset must be VISIBLE in the UI, with its real row count — this is
  // what proves the Parquet store reaches the screen, not just the API.
  // SCOPED to the list's own row-count cell. A document-wide text search also
  // matches the import hint ("CSV, JSON or Excel — up to 1,000,000 rows."),
  // which would pass this check with the dataset absent from the screen —
  // exactly the failure it exists to catch. The cell groups thousands now, so
  // the separator is whatever the runtime locale picks, or none.
  const listed: string | null = await win.evaluate(() => {
    const el = [...document.querySelectorAll('#ds-saved-list .ds-saved-item .ds-saved-meta')].find(
      (el2) => /1[,.\u202f\u00a0\s]?000[,.\u202f\u00a0\s]?000 rows/.test(el2.textContent || ''),
    );
    return el ? (el.textContent || '').trim().slice(0, 60) : null;
  });
  ok('dataset is listed in the UI with its row count', listed !== null, listed || 'not rendered');

  // ── Refresh, end to end ───────────────────────────────────────────────────
  // The one check that proves the whole chain: a file on disk changes, the user
  // clicks ↻ Refresh, and the RENDERED row count follows. Every layer is real —
  // the stored origin, the re-read through the shared parser, updateDatasetData,
  // and the repaint. Nothing here is stubbed.
  const beforeRefresh = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
    const row = rows.find((el) => /Refreshable/.test(el.textContent || ''));
    return {
      found: !!row,
      text: (row?.querySelector('.ds-saved-meta')?.textContent || ''),
      fresh: (row?.querySelector('.ds-fresh')?.textContent || ''),
      hasButton: !!row?.querySelector('.ds-saved-refresh'),
    };
  });
  ok('the file-backed dataset shows 2 rows and a ↻ Refresh button',
     beforeRefresh.found && /^2 rows/.test(beforeRefresh.text) && beforeRefresh.hasButton,
     JSON.stringify(beforeRefresh));
  ok('…with a "Data as of" freshness line rather than a bare timestamp',
     /Data as of/.test(beforeRefresh.fresh), `"${beforeRefresh.fresh}"`);

  // A dataset with no origin must NOT offer the button, and must say "Imported".
  const notRefreshable = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
    const row = rows.find((el) => /By state/.test(el.textContent || ''));
    return {
      found: !!row,
      hasButton: !!row?.querySelector('.ds-saved-refresh'),
      fresh: row?.querySelector('.ds-fresh')?.textContent || '',
      titled: !!(row?.querySelector('.ds-fresh') as HTMLElement)?.title,
    };
  });
  ok('a dataset with no origin offers no Refresh button and reads "Imported"',
     notRefreshable.found && !notRefreshable.hasButton && /Imported/.test(notRefreshable.fresh)
     && notRefreshable.titled, JSON.stringify(notRefreshable));

  // Rewrite the CSV from OUTSIDE the app, exactly as an upstream export would.
  fs.writeFileSync(r.csvPath, 'city,visits\nOslo,10\nBergen,20\nTromso,30\nStavanger,40\n', 'utf8');

  ok('↻ Refresh is clickable on that row', await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
    const row = rows.find((el) => /Refreshable/.test(el.textContent || ''));
    const btn = row?.querySelector('.ds-saved-refresh') as HTMLElement | undefined;
    if (!btn) return false;
    btn.click();
    return true;
  }));

  // Wait for the COUNT to change rather than sleeping a fixed amount: this is a
  // real file read plus a Parquet rewrite, and its latency tracks the host.
  await win
    .waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
        const row = rows.find((el) => /Refreshable/.test(el.textContent || ''));
        return /^4 rows/.test(row?.querySelector('.ds-saved-meta')?.textContent || '');
      },
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {}); // fall through to the assertion, which reports what is there

  const afterRefresh = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
    const row = rows.find((el) => /Refreshable/.test(el.textContent || ''));
    return {
      text: row?.querySelector('.ds-saved-meta')?.textContent || '',
      status: row?.querySelector('.ds-refresh-status')?.textContent || '',
      errored: !!row?.querySelector('.ds-fresh-dot'),
    };
  });
  ok('refreshing re-reads the changed file and the rendered row count follows',
     /^4 rows/.test(afterRefresh.text), JSON.stringify(afterRefresh));
  ok('…with no error state left on the row',
     !afterRefresh.errored && afterRefresh.status === '', JSON.stringify(afterRefresh));

  // And the failure half of the contract: delete the file, refresh, and the
  // stored rows must survive.
  fs.rmSync(r.csvPath);
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
    const row = rows.find((el) => /Refreshable/.test(el.textContent || ''));
    (row?.querySelector('.ds-saved-refresh') as HTMLElement | undefined)?.click();
  });
  await win
    .waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
        const row = rows.find((el) => /Refreshable/.test(el.textContent || ''));
        return !!row?.querySelector('.ds-refresh-status.is-error');
      },
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {});
  const afterFailure = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')] as HTMLElement[];
    const row = rows.find((el) => /Refreshable/.test(el.textContent || ''));
    return {
      text: row?.querySelector('.ds-saved-meta')?.textContent || '',
      status: row?.querySelector('.ds-refresh-status')?.textContent || '',
      isError: !!row?.querySelector('.ds-refresh-status.is-error'),
    };
  });
  ok('a refresh whose file has vanished reports inline, never in an alert',
     afterFailure.isError && /no longer at/.test(afterFailure.status), JSON.stringify(afterFailure));
  ok('…and the 4 rows it already had are still there',
     /^4 rows/.test(afterFailure.text), JSON.stringify(afterFailure));

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 3).join(' | '));

  await smoke.close();
}

main()
  .then(() => finishSmoke('app', failureCount()))
  .catch((err) => {
    console.error('SMOKE DRIVER ERROR:', err && err.message ? err.message : err);
    process.exit(1);
  });
