// Round-10 smoke SECTION: drag and drop, driven through the REAL app. Not a
// standalone smoke — scripts/smoke-round10.ts calls dragDropSection(s, fx).
//
//   The overlay: a synthetic file drag names what will happen ("Import 3 files
//   into Smoke test") and goes away on leave → real files on disk (a CSV, a
//   Parquet file, a CSV saved as .json, a PNG renamed .csv) reach main through
//   real File objects (an <input type=file>, the same kind a drop carries):
//   three datasets arrive through import JOBS, the PNG is refused with a toast
//   naming it → a GeoJSON over a map's settings says "Add boundaries to this
//   map" and lands selected → pasting a table on Data opens the composer;
//   pasting an image on Home runs the capture flow's no-model path → a dataset
//   row and a chart drag OUT: main writes the CSV / PNG to the temp folder and
//   calls startDrag (stubbed — Playwright cannot finish an OS drag) → a Visuals
//   card dropped on an open dashboard tab lands on that dashboard.
//
// Everything it creates is deleted: the datasets, the boundary, the dashboard
// (and its tab), the temp files; the composer is closed. The sample dashboard
// is never touched.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject, seedAnalysis } from './smokeFixture';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Page-level globals, read by bare name inside evaluate (never window.x).
declare const dashCurrent: any;
declare let dashSaveTimer: number | null;
declare const tabState: any;

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(200);
  }
  return false;
}

const toasts = (win: Win): Promise<string[]> =>
  win.evaluate(() => [...document.querySelectorAll('#hub-toast .toast-text')].map((e) => (e.textContent || '').trim()));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

export async function dragDropSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const pid = fx.projectId;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-r10-dnd-'));
  const created: { datasets: string[]; boundary: string; analysis: string } = { datasets: [], boundary: '', analysis: '' };

  try {
    await openProject(win, pid);
    await win.evaluate(() => { (window as any).selectSection('datasets'); });
    await win.waitForTimeout(800);

    // ── The overlay names the drop ─────────────────────────────────────────
    const overlay = await win.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['a,b\n1,2\n'], 'a.csv', { type: 'text/csv' }));
      dt.items.add(new File(['[]'], 'b.json', { type: 'application/json' }));
      dt.items.add(new File(['x'], 'c.csv', { type: 'text/csv' }));
      const target = document.getElementById('ws-datasets') || document.body;
      target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(over);
      const el = document.querySelector('.dnd-overlay') as HTMLElement | null;
      const shown = { visible: !!el && !el.hidden && el.getClientRects().length > 0, title: el?.querySelector('.dnd-title')?.textContent || '', accepted: over.defaultPrevented };
      target.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return { ...shown, hiddenAfter: !!el && el.hidden === true };
    });
    ok('dragdrop: a file drag shows the full-window overlay', overlay.visible && overlay.accepted, JSON.stringify(overlay));
    ok('dragdrop: it names the action — "Import 3 files into Smoke test"', overlay.title === 'Import 3 files into Smoke test', overlay.title);
    ok('dragdrop: leaving the window hides it', overlay.hiddenAfter);

    // ── Real files, sniffed by content in main ─────────────────────────────
    fs.writeFileSync(path.join(dir, 'dnd-sales.csv'), 'region,amount\nWest,10\nEast,20\nNorth,30\n');
    fs.writeFileSync(path.join(dir, 'dnd-really-csv.json'), 'city;visits\nOslo;10\nBergen;20\n');
    fs.writeFileSync(path.join(dir, 'dnd-photo.csv'), PNG);
    // A real Parquet file: written by the app's own store inside userData (the
    // one place its DuckDB may write), then copied out like any user's file.
    const pq = path.join(dir, 'dnd-orders.parquet');
    await app.evaluate(async (_e, out: string) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const store = req('./src/engine/parquetStore.js');
      const tmp = req('path').join(req('electron').app.getPath('userData'), 'r10-dnd-fixture.parquet');
      await store.writeTableAsync(tmp, [{ name: 'a', type: 'text' }, { name: 'b', type: 'text' }], [['007', '1'], ['008', '2']]);
      req('fs').copyFileSync(tmp, out);
      req('fs').rmSync(tmp, { force: true });
    }, pq);

    const before: string[] = await app.evaluate(async (_e, p: string) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      return (await req('./src/data/datasets.js').listDatasets(p)).map((d: any) => d.id);
    }, pid);
    await win.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.id = 'r10-dnd-input';
      input.hidden = true;
      document.body.appendChild(input);
    });
    await win.setInputFiles('#r10-dnd-input', ['dnd-sales.csv', 'dnd-orders.parquet', 'dnd-really-csv.json', 'dnd-photo.csv'].map((n) => path.join(dir, n)));
    await win.evaluate(() => {
      const input = document.getElementById('r10-dnd-input') as HTMLInputElement;
      void (window as any).dndDropFiles(Array.from(input.files || []), null);
    });
    const arrived = await until(win, () => app.evaluate(async (_e, a: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const now = (await req('./src/data/datasets.js').listDatasets(a.pid)).filter((d: any) => a.before.indexOf(d.id) < 0);
      return now.length >= 3;
    }, { pid, before }), 45_000);
    const fresh: any[] = await app.evaluate(async (_e, a: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      return (await req('./src/data/datasets.js').listDatasets(a.pid)).filter((d: any) => a.before.indexOf(d.id) < 0)
        .map((d: any) => ({ id: d.id, name: d.name, rowCount: d.rowCount, sourceKind: d.sourceKind, cols: d.columnCount ?? (d.columns ? d.columns.length : -1) }));
    }, { pid, before });
    created.datasets = fresh.map((d) => d.id);
    const byName = (n: string): any => fresh.find((d) => d.name === n);
    ok('dragdrop: three dropped data files became datasets', arrived && fresh.length === 3, JSON.stringify(fresh));
    ok('dragdrop: the CSV imported, 3 rows', !!byName('dnd-sales') && byName('dnd-sales').rowCount === 3, JSON.stringify(fresh));
    ok('dragdrop: the Parquet file imported, 2 rows, as Parquet', !!byName('dnd-orders') && byName('dnd-orders').rowCount === 2 && byName('dnd-orders').sourceKind === 'parquet', JSON.stringify(fresh));
    ok('dragdrop: a .json that is really CSV imported as CSV (content, not name)', !!byName('dnd-really-csv') && byName('dnd-really-csv').rowCount === 2 && byName('dnd-really-csv').sourceKind === 'csv', JSON.stringify(fresh));
    const leadingZero: string = await app.evaluate(async (_e, a: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const ds = await req('./src/data/datasets.js').getDataset(a.pid, a.id);
      return ds ? String(ds.rows[0][0]) : '';
    }, { pid, id: byName('dnd-orders') ? byName('dnd-orders').id : '' });
    ok('dragdrop: Parquet values keep their leading zeros (VARCHAR, typed by the importer)', leadingZero === '007', leadingZero);
    const jobLabels: string[] = await app.evaluate(() => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      return req('./src/app/jobs.js').snapshot().recent.filter((j: any) => j.state === 'done').map((j: any) => j.label);
    });
    ok('dragdrop: each file was its own import job', ['dnd-sales.csv', 'dnd-orders.parquet', 'dnd-really-csv.json'].every((n) => jobLabels.indexOf('Import ' + n) >= 0), jobLabels.join(' | '));
    ok('dragdrop: the PNG renamed .csv is refused with a toast naming it', await until(win, async () => (await toasts(win)).some((t) => /dnd-photo\.csv is a PNG image/.test(t)), 5000), (await toasts(win)).join(' | '));
    ok('dragdrop: no dataset was made from the PNG', !fresh.some((d) => d.name === 'dnd-photo'));

    // ── A GeoJSON on a map's settings ──────────────────────────────────────
    await win.evaluate(() => { (window as any).selectSection('visuals'); });
    await win.waitForTimeout(500);
    await win.evaluate((id: string) => (window as any).openSavedVisual(id), fx.mapVisualId);
    const zoneReady = await until(win, () => win.evaluate(() => {
      const z = document.querySelector('[data-drop-zone="boundaries"]') as HTMLElement | null;
      return !!z && z.getClientRects().length > 0;
    }), 15_000);
    ok('dragdrop: a map\'s settings are a boundaries drop zone', zoneReady);
    const zoneTitle = await win.evaluate(() => {
      const z = document.querySelector('[data-drop-zone="boundaries"]') as HTMLElement;
      const dt = new DataTransfer();
      dt.items.add(new File(['{}'], 'regions.geojson', { type: 'application/geo+json' }));
      z.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      z.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const t = document.querySelector('.dnd-overlay .dnd-title')?.textContent || '';
      z.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return t;
    });
    ok('dragdrop: over it, the overlay says "Add boundaries to this map"', zoneTitle === 'Add boundaries to this map', zoneTitle);
    fs.writeFileSync(path.join(dir, 'dnd-regions.geojson'), JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { name: 'Box' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] } }],
    }));
    await win.setInputFiles('#r10-dnd-input', [path.join(dir, 'dnd-regions.geojson')]);
    await win.evaluate(() => {
      const input = document.getElementById('r10-dnd-input') as HTMLInputElement;
      void (window as any).dndDropFiles(Array.from(input.files || []), document.querySelector('[data-drop-zone="boundaries"]'));
    });
    const picked = await until(win, () => win.evaluate(() => {
      const sel = document.querySelector('.js-enc-geo') as HTMLSelectElement | null;
      return !!sel && sel.value.startsWith('custom:');
    }), 15_000);
    created.boundary = await win.evaluate(() => ((document.querySelector('.js-enc-geo') as HTMLSelectElement | null)?.value || '').replace('custom:', ''));
    ok('dragdrop: the GeoJSON became the map\'s boundaries, selected', picked && !!created.boundary);
    await win.evaluate(() => (window as any).closeVisualBuilder());

    // ── Paste a table on Data → the composer ───────────────────────────────
    await win.evaluate(() => { (window as any).selectSection('datasets'); (document.activeElement as HTMLElement | null)?.blur(); });
    await win.waitForTimeout(400);
    await win.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'city\tvisits\nOslo\t10\nBergen\t20\n');
      document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    });
    const composer = await until(win, () => win.evaluate(() => {
      const c = document.getElementById('ds-composer');
      const n = document.getElementById('dc-name') as HTMLInputElement | null;
      return !!c && !c.hidden && !!n && n.value === 'Pasted data';
    }), 10_000);
    ok('dragdrop: pasting a table on Data opens the composer, prefilled', composer);
    await win.evaluate(() => (window as any).closeComposer());

    // ── Paste an image on Home → the capture flow (no model: Settings) ─────
    await app.evaluate(({ clipboard, nativeImage }, b64: string) => {
      (global as any).__r10ReadImage = clipboard.readImage;
      clipboard.readImage = () => nativeImage.createFromBuffer(Buffer.from(b64, 'base64'));
    }, PNG.toString('base64'));
    await win.evaluate(() => { (window as any).selectSection('home'); (document.activeElement as HTMLElement | null)?.blur(); });
    await win.waitForTimeout(400);
    await win.evaluate((b64: string) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
      document.body.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    }, PNG.toString('base64'));
    ok('dragdrop: pasting an image without a model says capture needs one', await until(win, async () => (await toasts(win)).some((t) => /needs a model/.test(t)), 8000), (await toasts(win)).join(' | '));
    ok('dragdrop: …and opens Settings, as New capture does', await until(win, () => win.evaluate(() => {
      const p = document.getElementById('settings-panel');
      return !!p && !p.hidden && p.getClientRects().length > 0;
    }), 5000));
    await win.evaluate(() => (document.getElementById('stp-close') as HTMLElement | null)?.click());
    await app.evaluate(({ clipboard }) => { clipboard.readImage = (global as any).__r10ReadImage; });

    // ── Drag OUT: a dataset row as CSV, a chart as PNG ─────────────────────
    await app.evaluate(({ webContents }) => {
      const wc = webContents.getAllWebContents()[0];
      const proto = Object.getPrototypeOf(wc);
      (global as any).__r10Drags = [];
      (global as any).__r10StartDrag = proto.startDrag;
      proto.startDrag = function (o: any) { (global as any).__r10Drags.push({ file: o.file, icon: !!o.icon && !o.icon.isEmpty() }); };
    });
    const drags = (): Promise<Array<{ file: string; icon: boolean }>> => app.evaluate(() => (global as any).__r10Drags);
    const tempRoot: string = await app.evaluate(({ app: a }) => (process as any).mainModule.require('path').join(a.getPath('temp'), 'ordinate-drag'));

    await win.evaluate(() => { (window as any).selectSection('datasets'); });
    const rowThere = await until(win, () => win.evaluate((id: string) => !!document.querySelector('.ds-saved-item[data-rec-id="' + id + '"]'), fx.datasetId), 10_000);
    ok('dragdrop: the Sales row is on the Data list, draggable', rowThere && await win.evaluate((id: string) => (document.querySelector('.ds-saved-item[data-rec-id="' + id + '"]') as HTMLElement).draggable, fx.datasetId));
    await win.evaluate((id: string) => {
      const row = document.querySelector('.ds-saved-item[data-rec-id="' + id + '"]') as HTMLElement;
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    }, fx.datasetId);
    ok('dragdrop: dragging the row starts an OS drag', await until(win, async () => (await drags()).length === 1, 15_000));
    const csvDrag = (await drags())[0];
    const csv = csvDrag && fs.existsSync(csvDrag.file) ? fs.readFileSync(csvDrag.file, 'utf8') : '';
    const csvLines = csv.split('\r\n').filter(Boolean);
    ok('dragdrop: …carrying Sales.csv in the temp drag folder', !!csvDrag && path.basename(csvDrag.file) === 'Sales.csv' && csvDrag.file.startsWith(tempRoot) && csvDrag.icon, JSON.stringify(csvDrag));
    ok('dragdrop: the CSV is the whole current table, header first', csvLines[0] === 'region,sku,amount,note' && csvLines.length === fx.rowCount + 1, `${csvLines[0]} · ${csvLines.length}`);
    ok('dragdrop: leading zeros survive and negatives stay numbers', csvLines[1] === 'region0,000,-10,' && csvLines[2] === 'region1,001,-9,n1', csvLines.slice(1, 3).join(' | '));

    await win.evaluate(() => { (window as any).selectSection('visuals'); });
    await win.evaluate((id: string) => (window as any).openSavedVisual(id), fx.visualId);
    const canvasUp = await until(win, () => win.evaluate(() => !!document.querySelector('#viz-area canvas')), 15_000);
    await win.waitForTimeout(800); // the chart's first frame
    const grip = await win.evaluate(() => {
      const c = document.querySelector('#viz-area canvas') as HTMLCanvasElement;
      c.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const g = document.querySelector('.dnd-grip') as HTMLElement | null;
      return !!g && !g.hidden && g.getClientRects().length > 0;
    });
    ok('dragdrop: hovering a chart shows its drag-out grip', canvasUp && grip);
    await win.evaluate(() => {
      document.querySelector('.dnd-grip')!.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
    });
    ok('dragdrop: dragging the grip starts an OS drag', await until(win, async () => (await drags()).length === 2, 10_000));
    const pngDrag = (await drags())[1];
    const head = pngDrag && fs.existsSync(pngDrag.file) ? fs.readFileSync(pngDrag.file).subarray(0, 8) : Buffer.alloc(0);
    ok('dragdrop: …carrying "Sales by region.png", a real PNG', !!pngDrag && path.basename(pngDrag.file) === 'Sales by region.png' && head.equals(PNG.subarray(0, 8)) && pngDrag.file.startsWith(tempRoot), JSON.stringify(pngDrag));
    await win.evaluate(() => (window as any).closeVisualBuilder());
    await app.evaluate(({ webContents }) => {
      Object.getPrototypeOf(webContents.getAllWebContents()[0]).startDrag = (global as any).__r10StartDrag;
    });

    // ── A Visuals card onto an open dashboard tab ──────────────────────────
    created.analysis = await seedAnalysis(app, pid, { name: 'DnD target', sheets: [{ name: 'Sheet 1', cards: [] }] });
    await win.evaluate(() => { (window as any).selectSection('analyses'); });
    await win.evaluate((id: string) => (window as any).openAnalysis(id), created.analysis);
    const key = 'analysis:' + created.analysis;
    const tabbed = await until(win, () => win.evaluate((k: string) => !!document.querySelector('.tab-item[data-key="' + k + '"]'), key), 10_000);
    ok('dragdrop: the dashboard is open in a tab', tabbed);
    await win.evaluate(() => { (window as any).selectSection('visuals'); });
    const cardThere = await until(win, () => win.evaluate((id: string) => !!document.querySelector('.viz-card[data-rec-id="' + id + '"]'), fx.visualId), 10_000);
    ok('dragdrop: the visual\'s card is on the Visuals page, draggable', cardThere && await win.evaluate((id: string) => (document.querySelector('.viz-card[data-rec-id="' + id + '"]') as HTMLElement).draggable, fx.visualId));
    const dropped = await win.evaluate((a: { id: string; key: string }) => {
      const card = document.querySelector('.viz-card[data-rec-id="' + a.id + '"]') as HTMLElement;
      const tab = document.querySelector('.tab-item[data-key="' + a.key + '"]') as HTMLElement;
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt });
      tab.dispatchEvent(over);
      const lit = tab.classList.contains('dnd-target-over');
      tab.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
      return { accepted: over.defaultPrevented, lit };
    }, { id: fx.visualId, key });
    ok('dragdrop: a dashboard tab accepts the card and lights up', dropped.accepted && dropped.lit, JSON.stringify(dropped));
    const landed = await until(win, () => win.evaluate((a: { aid: string; vid: string }) =>
      !!dashCurrent && String(dashCurrent.id) === a.aid
      && dashCurrent.pages[0].cards.some((c: any) => c.type === 'visual' && c.visualId === a.vid)
      && !!document.querySelector('#dash-grid .dash-card'), { aid: created.analysis, vid: fx.visualId }), 15_000);
    ok('dragdrop: dropping switches to that dashboard with the visual added as a card', landed);
    const saved = await until(win, () => app.evaluate(async (_e, a: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const rec = await req('./src/analysis/analysis.js').getAnalysis(a.pid, a.aid);
      const sheets = rec && (rec.sheets || rec.pages) || [];
      return sheets.some((s: any) => (s.cards || []).some((c: any) => c.visualId === a.vid));
    }, { pid, aid: created.analysis, vid: fx.visualId }), 10_000);
    ok('dragdrop: …and it is saved', saved);
    await win.evaluate(async (k: string) => {
      if (dashSaveTimer) clearTimeout(dashSaveTimer);
      dashSaveTimer = null;
      await (window as any).tabCloseKey(k);
    }, key);
    ok('dragdrop: its tab closes again', await until(win, () => win.evaluate((k: string) => !tabState.tabs.some((t: any) => t.kind + ':' + t.id === k), key), 5000));
  } finally {
    await win.evaluate(() => {
      document.getElementById('r10-dnd-input')?.remove();
      const c = document.getElementById('ds-composer');
      if (c && !c.hidden) (window as any).closeComposer();
    }).catch(() => undefined);
    await app.evaluate(async (_e, a: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const datasets = req('./src/data/datasets.js');
      for (const id of a.datasets) await datasets.deleteDataset(a.pid, id);
      if (a.analysis) await req('./src/analysis/analysis.js').deleteAnalysis(a.pid, a.analysis);
      const p = req('path');
      const userData = req('electron').app.getPath('userData');
      if (/^[0-9a-f-]{36}$/i.test(a.boundary)) req('fs').rmSync(p.join(userData, 'projects', a.pid, 'boundaries', a.boundary + '.json'), { force: true });
      req('fs').rmSync(p.join(req('electron').app.getPath('temp'), 'ordinate-drag'), { recursive: true, force: true });
    }, { pid, ...created }).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
    await win.evaluate(() => { (window as any).selectSection('datasets'); }).catch(() => undefined);
  }
}
