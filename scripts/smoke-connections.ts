// End-to-end smoke test of the CONNECTION WORKBENCH — launches the REAL app.
//
// WHAT THIS GUARDS, and why it needs a real Electron boot rather than a DOM
// harness: every claim below is a claim about a chain that crosses the process
// boundary twice and is `typeof x === 'function'`-guarded on the way — the
// renderer's schema tree → `connection:describe` → the registry → the DuckDB
// worker → back. A rename anywhere along it degrades SILENTLY: no build error,
// no lint error, and a tree that simply never fills in.
//
// THE FIXTURE IS A REAL DATABASE, built through the app's OWN DuckDB bridge
// (`src/engine/duckdb.ts`) rather than by shelling out or committing a binary.
// That matters twice over: the file is written by the same engine the connector
// then ATTACHes read-only, so a version skew between them is impossible; and
// `duckdb-file` is the one connector in the 35-source registry that can be
// exercised end to end with no server, no credentials and no network.
//
// THE LOAD-BEARING ASSERTION is the last one about numbers: the grid's rows are
// compared against the app's own aggregate of the same file, computed
// independently through the bridge. Every other check here proves a control
// exists and responds; that one proves the WORKBENCH SHOWS THE RIGHT FIGURES,
// which is the only property a query editor really has.
//
// Separate script, not more lines in smoke-app.ts, for the reason
// smoke-connect.ts / smoke-composer.ts already are: smoke-app.ts is allowlisted
// in scripts/test-file-size.ts and that ratchet only tightens.
//
//   npm run smoke

export {}; // module scope — sibling scripts share top-level names
import { ok, failureCount } from './selfcheck';
import { launchSmoke, openProject, domDriver } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

/** The aggregate the workbench's query must reproduce, computed independently. */
interface Expected {
  dbPath: string;
  projectId: string;
  /** region -> revenue, from the app's own DuckDB, as display strings. */
  totals: Record<string, string>;
}

async function main(): Promise<void> {
  const s = await launchSmoke('connections');
  const { win, errors } = s;

  await win.waitForSelector('#splash', { state: 'hidden', timeout: 60_000 }).catch(() => {});
  await s.killSplash();
  await win.waitForSelector('#side-ai-btn', { timeout: 60_000 });

  // ── Fixture: a project, and a two-table .duckdb file ──────────────────────
  const seeded: Expected = await s.app.evaluate(async () => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const projects = req('./src/app/projects.js');
    const duck = req('./src/engine/duckdb.js');
    const nodePath = req('path');
    const userData = req('electron').app.getPath('userData');

    await projects.init();
    const project = await projects.createProject('Workbench smoke');

    // Written through the app's own bridge, so the file the connector attaches
    // was produced by the identical engine build. ATTACH without READ_ONLY here
    // (this is the one place in the app that writes a .duckdb) and DETACH after,
    // so the connector's own read-only attach is never fighting a live handle.
    const dbPath = nodePath.join(userData, 'workbench-smoke.duckdb');
    try { req('fs').rmSync(dbPath, { force: true }); } catch { /* first run */ }
    await duck.execAsync(`ATTACH '${dbPath}' AS seed (TYPE DUCKDB)`);
    try {
      await duck.execAsync(
        'CREATE TABLE seed.main.orders (region VARCHAR, sku VARCHAR, revenue DOUBLE)',
      );
      // Deliberately lopsided per region, and with a leading-zero sku, so the
      // aggregate below is a number nothing else in the app could coincidentally
      // produce and `007` has somewhere to stay text.
      await duck.execAsync(
        "INSERT INTO seed.main.orders VALUES "
        + "('north', '007', 10.5), ('north', '008', 4.5), "
        + "('south', '007', 30.0), ('east', '009', 55.25)",
      );
      await duck.execAsync('CREATE TABLE seed.main.regions (region VARCHAR, manager VARCHAR)');
      await duck.execAsync(
        "INSERT INTO seed.main.regions VALUES ('north', 'Ada'), ('south', 'Bo'), ('east', 'Cy')",
      );
      // THE INDEPENDENT ANSWER. Computed here, by the engine, over the same
      // file — never by restating what the UI is about to show.
      const rows = await duck.queryAsync(
        'SELECT region, CAST(sum(revenue) AS DOUBLE) AS revenue '
        + 'FROM seed.main.orders GROUP BY 1 ORDER BY 1',
      );
      const totals: Record<string, string> = {};
      for (const r of rows) totals[String(r.region)] = String(r.revenue);
      return { dbPath, projectId: project.id, totals };
    } finally {
      await duck.execAsync('DETACH seed').catch(() => {});
    }
  });

  ok('fixture: the app\'s own DuckDB wrote a two-table database',
     fs.existsSync(seeded.dbPath), seeded.dbPath);
  ok('fixture: it computed the aggregate the UI must reproduce',
     Object.keys(seeded.totals).length === 3, JSON.stringify(seeded.totals));

  await openProject(win, seeded.projectId);

  // ── Add the connection through the REAL form ──────────────────────────────
  // Not through connections.saveConnection: the point is that the generic,
  // data-driven form in connNew.ts still produces a record the workbench can
  // open, and a seeded record would prove nothing about that path.
  await win.evaluate(() => { (window as any).openConnPanel('duckdb-file'); });
  await win.waitForFunction(() => {
    const el = document.getElementById('conn-form');
    return !!el && (el as HTMLElement).offsetParent !== null;
  }, null, { timeout: 30_000 }).catch(() => {});

  const formShown = await win.evaluate(() =>
    (document.getElementById('conn-chosen-name')?.textContent || '').trim());
  ok('the DuckDB file form opens from the catalog', /duckdb/i.test(formShown), formShown);

  await win.evaluate((dbPath: string) => {
    const name = document.getElementById('conn-name') as HTMLInputElement | null;
    if (name) name.value = 'Smoke warehouse';
    const field = document.getElementById('conn-f-path') as HTMLInputElement | null;
    if (field) field.value = dbPath;
  }, seeded.dbPath);
  await win.click('#conn-test-btn', { timeout: 8000 });

  // Test & Save now lands IN the workbench rather than back on the 35-source
  // picker — saving a connection is never the goal, querying it is.
  await win.waitForFunction(() => {
    const el = document.getElementById('conn-wb');
    return !!el && !(el as HTMLElement).hidden;
  }, null, { timeout: 60_000 }).catch(() => {});
  const wbOpen = await win.evaluate(() => {
    const wb = document.getElementById('conn-wb');
    const browse = document.getElementById('conn-browse');
    return {
      wb: !!wb && !(wb as HTMLElement).hidden,
      browse: !!browse && !(browse as HTMLElement).hidden,
      title: (document.getElementById('conn-wb-title')?.textContent || '').trim(),
    };
  });
  ok('Test & Save lands in the workbench, not back on the picker',
     wbOpen.wb && !wbOpen.browse && wbOpen.title === 'Smoke warehouse', JSON.stringify(wbOpen));

  // ── The schema tree lists both tables ─────────────────────────────────────
  await win.waitForFunction(
    () => document.querySelectorAll('#conn-wb-tree .cw-row-table').length >= 2,
    null, { timeout: 60_000 }).catch(() => {});
  const tables = await win.evaluate(() =>
    [...document.querySelectorAll('#conn-wb-tree .cw-node')]
      .map((n) => (n as HTMLElement).dataset.table || '').sort());
  ok('the schema tree lists both tables in the file',
     tables.length === 2 && tables[0] === 'orders' && tables[1] === 'regions',
     JSON.stringify(tables));

  // ── …with their columns, from the source's own catalog ────────────────────
  await win.evaluate(() => {
    const node = document.querySelector('.cw-node[data-table="orders"] .cw-caret') as HTMLElement | null;
    node?.click();
  });
  await win.waitForFunction(
    () => document.querySelectorAll('.cw-node[data-table="orders"] .cw-row-col').length >= 3,
    null, { timeout: 30_000 }).catch(() => {});
  const columns = await win.evaluate(() =>
    [...document.querySelectorAll('.cw-node[data-table="orders"] .cw-row-col')]
      .map((r) => ({
        name: (r.querySelector('.cw-row-name')?.textContent || '').trim(),
        type: (r.querySelector('.cw-col-type')?.textContent || '').trim(),
      })));
  ok('expanding a table shows its columns with the SOURCE\'s own type names',
     columns.length === 3
       && columns.map((c) => c.name).join(',') === 'region,sku,revenue'
       && /DOUBLE/i.test(columns[2].type),
     JSON.stringify(columns));

  // The row figure is the optimiser's ESTIMATE and must READ like one.
  const estimate = await win.evaluate(() =>
    (document.querySelector('.cw-est[data-est-for="orders"]')?.textContent || '').trim());
  ok('a row estimate is shown, marked as an estimate rather than a count',
     estimate.startsWith('~'), estimate);

  // ── Clicking a table shows its sample ─────────────────────────────────────
  await win.evaluate(() => {
    const row = document.querySelector('.cw-node[data-table="orders"] .cw-row-table') as HTMLElement | null;
    row?.click();
  });
  await win.waitForFunction(
    () => document.querySelectorAll('#conn-wb-grid .ds-table tbody tr').length >= 4,
    null, { timeout: 30_000 }).catch(() => {});
  const sample = await win.evaluate(() => {
    const rows = [...document.querySelectorAll('#conn-wb-grid .ds-table tbody tr')];
    return {
      count: rows.length,
      // The whole reason columns are stored VARCHAR: a leading zero must survive
      // the trip from the source to the grid.
      skus: rows.map((r) => (r.querySelectorAll('.ds-td')[1]?.textContent || '').trim()),
      selected: !!document.querySelector('.cw-node[data-table="orders"] .cw-row-table.is-on'),
    };
  });
  ok('clicking a table shows its sample, with the table selected',
     sample.count === 4 && sample.selected, JSON.stringify(sample));
  ok('…and a leading-zero id is still text in the grid, not 7',
     sample.skus.includes('007'), JSON.stringify(sample.skus));

  // ── Explain reports the columns a query would return, fetching no rows ────
  const SQL = 'select region, sum(revenue) as revenue from orders group by 1';
  await win.evaluate((sql: string) => { (window as any).cwSetSql(sql); }, SQL);
  await win.click('#conn-wb-explain', { timeout: 8000 });
  await win.waitForFunction(
    () => document.querySelectorAll('#conn-wb-cols .cw-col-chip').length >= 2,
    null, { timeout: 30_000 }).catch(() => {});
  const explained = await win.evaluate(() => ({
    chips: [...document.querySelectorAll('#conn-wb-cols .cw-col-chip-name')]
      .map((c) => (c.textContent || '').trim()),
    msg: (document.getElementById('conn-wb-msg')?.textContent || '').trim(),
    // Explain must not touch the grid — it fetches no rows.
    gridRows: document.querySelectorAll('#conn-wb-grid .ds-table tbody tr').length,
  }));
  ok('Explain reports the two columns the query would return',
     explained.chips.length === 2
       && explained.chips[0] === 'region' && explained.chips[1] === 'revenue'
       && /2 columns/.test(explained.msg),
     JSON.stringify(explained));
  ok('…without replacing the grid — Explain fetches no rows',
     explained.gridRows === 4, String(explained.gridRows));

  // ── Run shows rows that MATCH the app's own aggregate ─────────────────────
  await win.click('#conn-wb-run', { timeout: 8000 });
  await win.waitForFunction(
    () => document.querySelectorAll('#conn-wb-grid .ds-table tbody tr').length === 3,
    null, { timeout: 30_000 }).catch(() => {});
  const ran: Record<string, string> = await win.evaluate(() => {
    const out: Record<string, string> = {};
    for (const tr of document.querySelectorAll('#conn-wb-grid .ds-table tbody tr')) {
      const cells = tr.querySelectorAll('.ds-td');
      out[(cells[0]?.textContent || '').trim()] = (cells[1]?.textContent || '').trim();
    }
    return out;
  });
  const sameNumbers = Object.keys(seeded.totals).length === Object.keys(ran).length
    && Object.entries(seeded.totals).every(([k, v]) => Number(ran[k]) === Number(v));
  ok('Run shows rows equal to the app\'s OWN aggregate of the same file',
     sameNumbers, `ui=${JSON.stringify(ran)} engine=${JSON.stringify(seeded.totals)}`);

  // ── The saved-query library ──────────────────────────────────────────────
  // Covered here because it is entirely chip-driven: three small buttons whose
  // only job is to fire a handler, which is exactly the kind of control that
  // can be rendered perfectly and wired to nothing. (It was, once: an icon
  // swap dropped both listeners and nothing failed.)
  const dom = domDriver(win);
  await win.click('#conn-wb-save-query', { timeout: 8000 });
  await win.waitForTimeout(600);
  ok('Save query asks for a name through the IN-APP modal',
     await dom.fillPrompt('Revenue rollup'),
     'Electron does not implement window.prompt — see projects.ts promptModal');
  await win.waitForFunction(
    () => document.querySelectorAll('#conn-wb-queries .cw-chip').length === 1,
    null, { timeout: 30_000 }).catch(() => {});
  const chip = await win.evaluate(() => ({
    count: document.querySelectorAll('#conn-wb-queries .cw-chip').length,
    label: (document.querySelector('#conn-wb-queries .cw-chip-open')?.textContent || '').trim(),
    // The new query becomes the LOADED one, or the next save makes a duplicate.
    loaded: !!document.querySelector('#conn-wb-queries .cw-chip.is-on'),
  }));
  ok('…and the saved query appears as a chip, loaded into the editor',
     chip.count === 1 && chip.label === 'Revenue rollup' && chip.loaded, JSON.stringify(chip));

  await win.evaluate(() => {
    const btns = document.querySelectorAll('#conn-wb-queries .cw-chip .cw-chip-act');
    (btns[0] as HTMLElement | undefined)?.click(); // the pencil
  });
  await win.waitForTimeout(600);
  ok('the rename chip actually fires', await dom.fillPrompt('Regional revenue'),
     'the rename prompt never opened — the chip button is not wired');
  await win.waitForTimeout(1200);
  const renamed = await win.evaluate(() =>
    (document.querySelector('#conn-wb-queries .cw-chip-open')?.textContent || '').trim());
  ok('…and the chip takes the new name', renamed === 'Regional revenue', renamed);

  const storedSql = await s.app.evaluate(async (_e, projectId: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const connections = req('./src/connectors/connections.js');
    const list = await connections.listConnections(projectId);
    const q = list[0] && list[0].queries && list[0].queries[0];
    return q ? { name: q.name, sql: q.sql } : null;
  }, seeded.projectId);
  ok('…without touching the SQL — a rename must not change what a dataset was built from',
     !!storedSql && storedSql.name === 'Regional revenue'
       && String(storedSql.sql).includes('sum(revenue)'),
     JSON.stringify(storedSql));

  // ── Save as dataset hands off to the composer, prefilled ──────────────────
  await win.evaluate(() => {
    const name = document.getElementById('conn-wb-ds-name') as HTMLInputElement | null;
    if (name) name.value = 'Revenue by region';
  });
  await win.click('#conn-wb-save-ds', { timeout: 8000 });
  await win.waitForFunction(() => {
    const el = document.getElementById('ds-composer');
    return !!el && !(el as HTMLElement).hidden;
  }, null, { timeout: 60_000 }).catch(() => {});
  const composer = await win.evaluate(() => ({
    open: !(document.getElementById('ds-composer') as HTMLElement | null)?.hidden,
    name: (document.getElementById('dc-name') as HTMLInputElement | null)?.value || '',
  }));
  ok('Save as dataset opens the composer, prefilled with the query\'s name',
     composer.open && composer.name === 'Revenue by region', JSON.stringify(composer));

  await win.waitForFunction(
    () => document.querySelectorAll('#dc-grid tbody tr').length > 0,
    null, { timeout: 30_000 }).catch(() => {});
  await win.click('#dc-save', { timeout: 8000 }).catch(() => {});
  await win.waitForTimeout(3000);

  // ── The saved record on disk carries origin.sql ───────────────────────────
  const saved = await s.app.evaluate(async (_e, projectId: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const list = await datasets.listDatasets(projectId);
    const hit = list.find((d: any) => d.name === 'Revenue by region');
    if (!hit) return { found: false };
    const meta = await datasets.getDatasetMeta(projectId, hit.id);
    return {
      found: true,
      id: hit.id,
      rowCount: hit.rowCount,
      origin: meta && meta.origin,
      originConnId: hit.originConnId || '',
    };
  }, seeded.projectId);

  ok('the dataset is on disk with the rows the query produced',
     saved.found && saved.rowCount === 3, JSON.stringify(saved));
  ok('…and its origin carries the SQL that built it, so a refresh re-runs THAT',
     !!saved.origin && saved.origin.kind === 'connection'
       && String(saved.origin.sql || '').includes('sum(revenue)'),
     JSON.stringify(saved.origin));
  ok('…and the summary names the connection, so the Data row can draw its logo',
     !!saved.originConnId && saved.originConnId === (saved.origin && saved.origin.connId),
     String(saved.originConnId));

  // ── A schedule persists, and Refresh now moves the clock ──────────────────
  const scheduled = await s.app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    await datasets.setAutoRefresh(arg.projectId, arg.id, { every: 'hourly' });
    const list = await datasets.listDatasets(arg.projectId);
    const hit = list.find((d: any) => d.id === arg.id);
    return hit && hit.autoRefresh ? hit.autoRefresh.every : '';
  }, { projectId: seeded.projectId, id: saved.id });
  ok('setting the schedule to hourly persists on the dataset record',
     scheduled === 'hourly', String(scheduled));

  const refreshed = await s.app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const before = await datasets.getDatasetMeta(arg.projectId, arg.id);
    const res = await req('./src/data/datasetRefresh.js').refreshDataset(arg.projectId, arg.id);
    const after = await datasets.getDatasetMeta(arg.projectId, arg.id);
    return {
      ok: !!res.ok,
      error: res.ok ? '' : res.error,
      before: (before && before.lastRefreshedAt) || '',
      after: (after && after.lastRefreshedAt) || '',
      rows: after && after.rowCount,
      // The schedule must survive a refresh — a re-run that dropped it would
      // silently turn a scheduled dataset into a one-off.
      every: after && after.autoRefresh && after.autoRefresh.every,
    };
  }, { projectId: seeded.projectId, id: saved.id });
  ok('Refresh now re-runs the stored SQL and updates lastRefreshAt',
     refreshed.ok && !!refreshed.after && refreshed.after !== refreshed.before,
     JSON.stringify(refreshed));
  ok('…producing the same three rows, and keeping the schedule',
     refreshed.rows === 3 && refreshed.every === 'hourly', JSON.stringify(refreshed));

  // ── The Data page row reflects all of it ──────────────────────────────────
  await win.evaluate(() => {
    (window as any).selectSection?.('datasets');
    (window as any).refreshDatasetList?.();
  });
  await win.waitForTimeout(2000);
  const dataRow = await win.evaluate(() => {
    const row = [...document.querySelectorAll('#ds-saved-list .ds-saved-item')]
      .find((r) => (r.textContent || '').includes('Revenue by region')) as HTMLElement | undefined;
    if (!row) return { found: false };
    const seen = (sel: string): boolean => {
      const el = row.querySelector(sel) as HTMLElement | null;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    // The overflow NUMBER is for diagnosis; the assertion is about the OVERLAP,
    // because that is the actual defect. A row of text buttons is a font
    // metric — it measured 276px on macOS and 284px on CI's Linux — so
    // demanding an exact fit would fail on the next font stack with nothing
    // wrong, while an overlap means a cell really is painting over its
    // neighbour and something really is invisible.
    const actions = row.querySelector('.ds-row-actions') as HTMLElement | null;
    const sourceCell = row.querySelector('.ds-source-cell') as HTMLElement | null;
    let overflow = 0;
    let overlap = 0;
    if (actions) {
      let content = 0;
      for (const el of [...actions.children] as HTMLElement[]) content += el.getBoundingClientRect().width;
      content += 4 * Math.max(0, actions.children.length - 1);
      const box = actions.getBoundingClientRect();
      overflow = Math.round(content - box.width);
      // Where the leftmost control actually STARTS — that is what a too-small
      // track pushes back across its neighbours.
      const first = actions.children[0] as HTMLElement | undefined;
      const leftEdge = first ? first.getBoundingClientRect().left : box.left;
      if (sourceCell) overlap = Math.round(sourceCell.getBoundingClientRect().right - leftEdge);
    }
    return {
      found: true,
      fresh: (row.querySelector('.ds-fresh')?.textContent || '').trim(),
      logoSeen: seen('.ds-source-logo'),
      refreshSeen: seen('.ds-saved-refresh'),
      scheduleSeen: seen('.ds-auto-select'),
      schedule: (row.querySelector('.ds-auto-select') as HTMLSelectElement | null)?.value || '',
      actionOverflow: overflow,
      actionOverlapsSource: overlap,
    };
  });
  ok('the Data row SHOWS the connection\'s logo, its schedule and a Refresh action',
     !!dataRow.found && !!dataRow.logoSeen && !!dataRow.refreshSeen && !!dataRow.scheduleSeen
       && /Refreshes hourly/.test(dataRow.fresh || '') && dataRow.schedule === 'hourly',
     JSON.stringify(dataRow));
  // The action cell is a fixed grid track. When its controls outgrow it they do
  // not wrap or clip — they overflow LEFT, across Source and Rows, which is how
  // the logo above ended up invisible while still being in the DOM.
  ok('…and the action cell is not painting over Source',
     (dataRow.actionOverlapsSource ?? 0) <= 0,
     `overlap=${dataRow.actionOverlapsSource}px overflow=${dataRow.actionOverflow}px`);

  // ── The workbench at a 1000px window ─────────────────────────────────────
  // The rail collapses FIRST and the other two panes stay: the rail is ABOUT
  // the connection, the tree and the editor ARE the work. Asserted with
  // RECTANGLES, not `hidden` — a pane hidden by a media query has neither.
  await win.evaluate(() => { (window as any).selectSection?.('connect'); });
  await win.waitForTimeout(800);
  await win.evaluate(() => {
    const card = document.querySelector('#conn-saved-list .conn-card') as HTMLElement | null;
    card?.click();
  });
  await win.waitForTimeout(2500);
  await win.setViewportSize({ width: 1000, height: 900 });
  await win.waitForTimeout(800);
  const narrow = await win.evaluate(() => {
    const box = (sel: string): { w: number; h: number } => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return { w: 0, h: 0 };
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    const body = document.querySelector('.cw-body') as HTMLElement | null;
    const bodyRect = body ? body.getBoundingClientRect() : null;
    const editor = document.querySelector('.cw-edit-wrap') as HTMLElement | null;
    const editorRect = editor ? editor.getBoundingClientRect() : null;
    return {
      tree: box('.cw-tree-pane'),
      editor: box('.cw-edit-wrap'),
      details: box('#conn-wb-details'),
      // Nothing may spill out of the body: a pane wider than its container is
      // how a three-column layout silently becomes a horizontal scroll.
      spill: bodyRect && editorRect ? Math.round(editorRect.right - bodyRect.right) : 0,
      pageScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  ok('at a 1000px window the tree and the editor are still there…',
     narrow.tree.w > 0 && narrow.tree.h > 0 && narrow.editor.w > 0,
     JSON.stringify(narrow));
  ok('…the details rail is the pane that collapsed…',
     narrow.details.w === 0 && narrow.details.h === 0, JSON.stringify(narrow));
  ok('…and nothing overflows into a horizontal scroll',
     narrow.spill <= 0 && narrow.pageScroll <= 0, JSON.stringify(narrow));
  await win.setViewportSize({ width: 1180, height: 1170 });
  await win.waitForTimeout(800);

  // ── Screenshots for the PR ────────────────────────────────────────────────
  await win.evaluate(() => { (window as any).selectSection?.('connect'); });
  await win.waitForTimeout(1500);
  await win.screenshot({ path: path.join(s.shotDir, 'connections-list.png') }).catch(() => {});
  await win.evaluate(() => {
    const card = document.querySelector('#conn-saved-list .conn-card') as HTMLElement | null;
    card?.click();
  });
  await win.waitForTimeout(2500);
  await win.evaluate((sql: string) => { (window as any).cwSetSql(sql); }, SQL);
  await win.click('#conn-wb-run', { timeout: 8000 }).catch(() => {});
  await win.waitForTimeout(2500);
  await win.screenshot({ path: path.join(s.shotDir, 'connection-workbench.png') }).catch(() => {});
  await win.evaluate(() => { (window as any).selectSection?.('datasets'); });
  await win.waitForTimeout(1500);
  await win.screenshot({ path: path.join(s.shotDir, 'dataset-schedule.png') }).catch(() => {});

  ok('no renderer errors (incl. CSP violations)', errors.length === 0, errors.slice(0, 5).join(' | '));

  await s.close();
}

main()
  .then(() => {
    console.log('');
    if (failureCount()) {
      console.error(`${failureCount()} connection workbench smoke check(s) FAILED.`);
      process.exit(1);
    }
    console.log('All connection workbench smoke checks passed.');
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
