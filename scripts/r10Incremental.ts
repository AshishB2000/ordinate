// Round-10 smoke SECTION: incremental refresh, driven through the REAL UI. Not
// a standalone smoke — scripts/smoke-round10.ts calls incrementalSection(s, fx)
// on its one launch.
//
//   A CSV-folder connection on a temp folder (inside userData, so it is inside
//   DuckDB's directory lock) and a dataset imported from its orders.csv →
//   open the dataset page → the Incremental refresh panel is there, Off →
//   turn it on with cursor `updated` and key `id`, Save → ↻: the first run is
//   full and sets the mark → change one row and add one on disk → ↻: the log's
//   new row says 3 fetched / 1 inserted / 1 updated / mark 104, exactly main's
//   own log → "Full refresh now": a full run, and the table is the file.
//   The dataset, the connection and the folder it made are deleted; the sample
//   is never touched. No watcher is started (Watch this folder stays off).

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject } from './smokeFixture';

const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Page-level globals (dsExplorer.ts), read by bare name inside evaluate.
declare function openSavedDataset(id: string): Promise<void>;

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(200);
  }
  return false;
}

const click = (win: Win, sel: string): Promise<boolean> =>
  win.evaluate((q: string) => {
    const el = document.querySelector(q) as HTMLElement | null;
    if (!el || el.getClientRects().length === 0 || (el as HTMLButtonElement).disabled) return false;
    el.click();
    return true;
  }, sel);

/** The refresh log as drawn, newest first. */
const drawnLog = (win: Win): Promise<Array<{ mode: string; how: string; fetched: string; inserted: string; updated: string; mark: string }>> =>
  win.evaluate(() => [...document.querySelectorAll('#inc-panel .inc-log-row')].map((r) => ({
    mode: (r.querySelector('.inc-mode')?.textContent || '').trim(),
    how: (r.querySelector('.inc-run-how')?.textContent || '').trim(),
    fetched: (r.querySelector('.inc-fetched')?.textContent || '').trim(),
    inserted: (r.querySelector('.inc-inserted')?.textContent || '').trim(),
    updated: (r.querySelector('.inc-updated')?.textContent || '').trim(),
    mark: (r.querySelector('.inc-mark')?.textContent || '').trim(),
  })));

const fmt = (n: unknown): string => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');

export async function incrementalSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errors0 = s.errors.length;
  const pid = fx.projectId;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(400);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };

  // ── A folder connection and a dataset from it, through main ──────────────
  const made: { dir: string; connId: string; dsId: string } = await app.evaluate(async (_e, projectId: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const fs = req('fs');
    const p = req('path');
    const dir = p.join(req('electron').app.getPath('userData'), 'incr-smoke-' + req('crypto').randomUUID());
    fs.mkdirSync(dir);
    const text = 'id,updated,amount\n1,100,10\n2,101,20\n3,102,30\n';
    fs.writeFileSync(p.join(dir, 'orders.csv'), text);
    const conn = await req('./src/connectors/connections.js').saveConnection(projectId, {
      name: 'Incremental smoke folder', connectorId: 'csv-folder', values: { path: dir },
    });
    const parsed = req('./src/data/parse.js').parseCsv(text);
    const ds = await req('./src/data/datasets.js').saveDataset(projectId, {
      name: 'Incremental orders', sourceKind: 'csv', columns: parsed.columns, rows: parsed.rows,
      origin: { kind: 'connection', connId: conn.id, table: 'orders' },
    });
    return { dir, connId: conn ? conn.id : '', dsId: ds ? ds.id : '' };
  }, pid);
  ok('incremental: a folder connection and a dataset from it', !!made.connId && !!made.dsId);
  const mainLog = (): Promise<any> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const m = await req('./src/data/datasets.js').getDatasetMeta(a.pid, a.id);
    return { inc: m && m.incremental, rowCount: m && m.rowCount };
  }, { pid, id: made.dsId });
  const writeCsv = (text: string): Promise<void> => app.evaluate((_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    req('fs').writeFileSync(req('path').join(a.dir, 'orders.csv'), a.text);
  }, { dir: made.dir, text });
  const logRows = async (n: number): Promise<boolean> => until(win, async () => (await drawnLog(win)).length === n, 45_000);

  try {
    await openProject(win, pid);
    await win.evaluate(() => { (window as any).selectSection('datasets'); });
    await win.waitForTimeout(500);
    await win.evaluate((id: string) => openSavedDataset(id), made.dsId);
    ok('incremental: the dataset page shows the panel', await until(win, () => win.evaluate(() => {
      const p = document.getElementById('inc-panel');
      return !!p && !p.hidden && !!p.querySelector('.inc-sum');
    })));
    const off = await win.evaluate(() => (document.querySelector('#inc-panel .inc-pill')?.textContent || '').trim());
    ok('incremental: it starts Off', off === 'Off', off);
    const opts = await win.evaluate(() => {
      (document.querySelector('#inc-panel .inc-sum') as HTMLElement).click();
      return [...(document.getElementById('inc-cursor') as HTMLSelectElement).options].map((o) => o.value);
    });
    ok('incremental: only number/date columns are offered as the cursor', JSON.stringify(opts) === JSON.stringify(['id', 'updated', 'amount']), JSON.stringify(opts));
    const how = await win.evaluate(() => (document.querySelector('#inc-panel .inc-how')?.textContent || '').trim());
    ok('incremental: a folder says it re-reads changed files only', /changed since the last run/.test(how), how);
    ok('incremental: an empty log says what the first run does', await win.evaluate(() =>
      /first refresh is a full one/.test(document.querySelector('#inc-panel .inc-empty')?.textContent || '')));

    // ── Turn it on ──
    await win.evaluate(() => {
      (document.getElementById('inc-enabled') as HTMLInputElement).checked = true;
      const cur = document.getElementById('inc-cursor') as HTMLSelectElement;
      cur.value = 'updated';
      cur.dispatchEvent(new Event('change'));
      (document.getElementById('inc-key') as HTMLSelectElement).value = 'id';
      (document.getElementById('inc-lookback') as HTMLInputElement).value = '0';
    });
    ok('incremental: Save', await click(win, '#inc-save'));
    ok('incremental: saved, and the pill says On', await until(win, () => win.evaluate(() =>
      (document.querySelector('#inc-panel .inc-pill')?.textContent || '').trim() === 'On'
      && (document.getElementById('inc-msg')?.textContent || '') === 'Saved')));
    let m = await mainLog();
    ok('incremental: main stored cursor + key', !!m.inc && m.inc.enabled && m.inc.cursorColumn === 'updated' && m.inc.keyColumn === 'id', JSON.stringify(m.inc));
    await shot('incremental-settings.png');

    // ── First run: full ──
    ok('incremental: ↻ Refresh', await click(win, '#ds-explorer-refresh'));
    ok('incremental: the log shows the first run', await logRows(1));
    m = await mainLog();
    let row = (await drawnLog(win))[0];
    ok('incremental: the first run is full and sets the mark from the data', row.mode === 'Full' && row.mark === '102' && m.inc.highWater === 102, JSON.stringify(row));

    // ── Change a row and add one on disk, then refresh ──
    await win.waitForTimeout(50);
    await writeCsv('id,updated,amount\n1,100,10\n2,103,25\n3,102,30\n4,104,40\n');
    ok('incremental: ↻ Refresh again', await click(win, '#ds-explorer-refresh'));
    ok('incremental: the log shows the second run', await logRows(2));
    m = await mainLog();
    const e = m.inc.log[0];
    row = (await drawnLog(win))[0];
    ok('incremental: main ran it incrementally: 3 fetched, 1 inserted, 1 updated, mark 104',
      e.mode === 'incremental' && e.fetched === 3 && e.inserted === 1 && e.updated === 1 && e.highWater === 104, JSON.stringify(e));
    ok('incremental: the log row is main\'s own answer',
      row.mode === 'Incremental' && row.fetched === fmt(e.fetched) && row.inserted === fmt(e.inserted)
      && row.updated === fmt(e.updated) && row.mark === String(e.highWater), JSON.stringify(row));
    ok('incremental: …and names how it fetched', row.how === 'changed files, filtered at read', row.how);
    ok('incremental: the table now has 4 rows', m.rowCount === 4, String(m.rowCount));
    await shot('incremental-log.png');

    // ── Full refresh now ──
    ok('incremental: Full refresh now', await click(win, '#inc-full'));
    ok('incremental: the log shows a third run', await logRows(3));
    m = await mainLog();
    row = (await drawnLog(win))[0];
    ok('incremental: it was full, on request, and the mark is reset from the data',
      row.mode === 'Full' && /requested/i.test(row.how) && m.inc.log[0].mode === 'full' && m.inc.highWater === 104 && !m.inc.fullNext,
      JSON.stringify(row));
    ok('incremental: the run count restarted', m.inc.runsSinceFull === 0);
  } finally {
    // ── Leave no trace ──
    await win.evaluate(() => document.getElementById('ds-explorer-close')?.click());
    await app.evaluate(async (_e, a: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      await req('./src/data/datasets.js').deleteDataset(a.pid, a.dsId);
      await req('./src/connectors/connections.js').deleteConnection(a.pid, a.connId);
      req('fs').rmSync(a.dir, { recursive: true, force: true });
    }, { pid, ...made });
    await win.evaluate(() => (window as any).refreshDatasetList?.());
    await win.waitForTimeout(300);
  }
  const gone = await app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return !(await req('./src/data/datasets.js').getDatasetMeta(a.pid, a.dsId))
      && !(await req('./src/connectors/connections.js').getConnection(a.pid, a.connId))
      && !req('fs').existsSync(a.dir);
  }, { pid, ...made });
  ok('incremental: the dataset, connection and folder it made are deleted', gone);
  ok('incremental: no renderer errors in this section', s.errors.length === errors0, s.errors.slice(errors0).join('\n'));
}
