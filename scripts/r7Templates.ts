// Round-7 smoke SECTION: Save as template, driven through the REAL UI. Not a
// standalone smoke — scripts/smoke-round7.ts calls templatesSection(s, fx) on
// its one launch and fixture.
//
//   The bundled sample dashboard (seeded on first launch) → ⋯ → "Save as
//   template…" → the dialog lists its roles with kinds and usage, and a real
//   thumbnail of the grid → rename Revenue's role to "Sales", mark State
//   optional, save → main stores it in the WORKSPACE with those edits → Create
//   dashboard: the gallery opens on "Yours" FIRST, the card carries the
//   thumbnail → pick it, the mapping step maps every role back, Skip the
//   optional State and the summary says "1 skipped" → Create builds the
//   dashboard minus the map, reusing Month and the metrics rather than copying
//   them → export to `.ordinate-template` in a temp dir (save panel stubbed),
//   delete, re-import (open panel stubbed) → it is back under its own id.
//   Cleans up: the template, the dashboard it built and that dashboard's
//   visuals; restores both dialogs; leaves the fixture project's Data list on
//   screen with nothing open and the dock closed.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject, openSeededAnalysis } from './smokeFixture';

const path: typeof import('path') = require('path');
const fs: typeof import('fs') = require('fs');

type Win = Smoke['win'];
// Page-level globals (dashboards.ts), read by bare name inside evaluate — not on window.
declare let dashCurrent: any;
declare function dkSetOpen(open: boolean): void;

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(150);
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

const text = (win: Win, sel: string): Promise<string> =>
  win.evaluate((q: string) => (document.querySelector(q)?.textContent || '').replace(/\s+/g, ' ').trim(), sel);

const nextBtn = (win: Win): Promise<boolean> => win.evaluate(() => {
  const b = document.querySelector('.an-wiz-foot .btn-primary') as HTMLButtonElement | null;
  if (!b || b.disabled) return false;
  b.click();
  return true;
});

export async function templatesSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errors0 = s.errors.length;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(250);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };
  const main = <T>(fn: string, arg: any = {}): Promise<T> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const store = req('./src/app/userTemplateStore.js');
    const analysis = req('./src/analysis/analysis.js');
    const visuals = req('./src/analysis/visuals.js');
    const metrics = req('./src/analysis/metrics.js');
    const datasets = req('./src/data/datasets.js');
    if (a.fn === 'sample') return req('./src/app/config.js').get().sample || null;
    if (a.fn === 'templates') return store.listTemplates();
    if (a.fn === 'dropTemplate') return store.deleteTemplate(a.id);
    if (a.fn === 'analyses') return analysis.listAnalyses(a.pid);
    if (a.fn === 'analysis') return analysis.getAnalysis(a.pid, a.id);
    if (a.fn === 'counts') {
      const meta = await datasets.getDatasetMeta(a.pid, a.dsId);
      return { steps: (meta && meta.steps || []).length, metrics: (await metrics.listMetrics(a.pid)).length };
    }
    if (a.fn === 'dropAnalysis') {
      const rec = await analysis.getAnalysis(a.pid, a.id);
      for (const p of (rec && rec.sheets) || []) for (const c of p.cards) if (c.visualId) await visuals.deleteVisual(a.pid, c.visualId);
      return analysis.deleteAnalysis(a.pid, a.id);
    }
    return null;
  }, { fn, ...arg }) as Promise<T>;
  const stubDialogs = (file: string): Promise<void> => app.evaluate((electron, p: string) => {
    const g = globalThis as any;
    g.__utSave ||= electron.dialog.showSaveDialog;
    g.__utOpen ||= electron.dialog.showOpenDialog;
    electron.dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as any;
    electron.dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as any;
  }, file);
  const restoreDialogs = (): Promise<void> => app.evaluate((electron) => {
    const g = globalThis as any;
    if (g.__utSave) electron.dialog.showSaveDialog = g.__utSave;
    if (g.__utOpen) electron.dialog.showOpenDialog = g.__utOpen;
  });

  const sample: any = await main('sample');
  ok('templates: the bundled sample dashboard is there to save from', !!(sample && sample.projectId && sample.analysisId), JSON.stringify(sample));
  if (!sample || !sample.analysisId) return;
  const pid = String(sample.projectId);
  const before: any = await main('counts', { pid, dsId: sample.datasetId });
  const source: any = await main('analysis', { pid, id: sample.analysisId });
  const sourceCards = source.sheets[0].cards.length;

  await openProject(win, pid);
  await win.evaluate(() => (window as any).selectSection('analyses'));
  await win.waitForTimeout(1200);
  await openSeededAnalysis(win, 'Retail overview');
  ok('templates: the sample dashboard opens', await until(win, () => win.evaluate((id: string) =>
    !!dashCurrent && dashCurrent.id === id && document.querySelectorAll('#dash-grid .dash-card').length > 0, String(sample.analysisId))));
  await win.waitForTimeout(1500); // the charts draw before the thumbnail is taken

  // ── ⋯ → Save as template… ─────────────────────────────────────────────────
  ok('templates: the dashboard\'s More menu offers "Save as template…"', await click(win, '#an-more-btn') && await win.evaluate(() => {
    const item = [...document.querySelectorAll('.chart-menu-item')].find((b) => (b.textContent || '').trim() === 'Save as template…') as HTMLElement | undefined;
    item?.click();
    return !!item;
  }));
  ok('templates: the Save dialog opens, a real dialog with focus inside', await until(win, () => win.evaluate(() => {
    const box = document.querySelector('.ut-modal');
    return !!box && box.getAttribute('role') === 'dialog' && box.contains(document.activeElement);
  })));
  const dlg = await win.evaluate(() => ({
    roles: [...document.querySelectorAll('.ut-role[data-role]')].map((r) => [
      (r.querySelector('.ut-role-src')?.textContent || '').replace('from ', ''),
      (r.querySelector('.ut-kind')?.textContent || '').trim(),
      (r.querySelector('.ut-role-n')?.textContent || '').trim(),
    ]),
    thumb: (document.querySelector('.ut-thumb-img') as HTMLImageElement | null)?.src || '',
    stats: (document.querySelector('.ut-stats')?.textContent || ''),
  }));
  const kindOf = (col: string): string => (dlg.roles.find((r) => r[0] === col) || [])[1] || '';
  ok('templates: one role per column the sample reads — Month is a calculated field, not a role',
    dlg.roles.map((r) => r[0]).sort().join(',') === 'category,order_date,profit,revenue,state,units', JSON.stringify(dlg.roles));
  ok('templates: …each with its kind — order_date a Date, state a Place, revenue a Measure, category a Dimension',
    kindOf('order_date') === 'Date' && kindOf('state') === 'Place' && kindOf('revenue') === 'Measure' && kindOf('category') === 'Dimension',
    JSON.stringify(dlg.roles));
  ok('templates: …and where it is used, counted', dlg.roles.every((r) => /^\d+ places?$/.test(r[2]) && parseInt(r[2], 10) > 0));
  ok('templates: the thumbnail is the dashboard itself, rendered', /^data:image\/png;base64,/.test(dlg.thumb) && dlg.thumb.length > 5000, String(dlg.thumb.length));
  ok('templates: the summary counts the tiles, charts, calculated field and metrics', /tiles/.test(dlg.stats) && /1 calculated field/.test(dlg.stats), dlg.stats);
  await shot('r7-templates-save.png');

  const rowSel = (col: string): Promise<string> => win.evaluate((c: string) => {
    const r = [...document.querySelectorAll('.ut-role[data-role]')].find((x) => (x.querySelector('.ut-role-src')?.textContent || '') === 'from ' + c);
    return r ? `.ut-role[data-role="${(r as HTMLElement).dataset.role}"]` : '';
  }, col);
  const revenueRow = await rowSel('revenue');
  const stateRow = await rowSel('state');
  await win.evaluate((q: string) => {
    const el = document.querySelector(q) as HTMLInputElement;
    el.value = 'Sales';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, revenueRow + ' .ut-role-label');
  await win.evaluate((q: string) => (document.querySelector(q) as HTMLInputElement).click(), stateRow + ' .ut-req input');
  ok('templates: State marked optional says so', (await text(win, stateRow + ' .ut-req-t')) === 'Optional'
    && await win.evaluate((q: string) => document.querySelector(q)!.classList.contains('is-optional'), stateRow));
  await win.evaluate(() => {
    const el = document.querySelector('.ut-name') as HTMLInputElement;
    el.value = 'Smoke retail template';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  ok('templates: Save template', await click(win, '.ut-save'));
  ok('templates: the dialog closes on save', await until(win, () => win.evaluate(() => !document.querySelector('.ut-modal'))));

  const stored: any[] = await main('templates');
  const tpl = stored.find((t) => t.name === 'Smoke retail template');
  const roleBy = (label: string): any => tpl && tpl.roles.find((r: any) => r.label === label);
  ok('templates: main stored it in the workspace, with the edits and the thumbnail',
    !!tpl && !!roleBy('Sales') && roleBy('State') && roleBy('State').required === false && /^data:image\/png/.test(tpl.thumbnail),
    JSON.stringify(tpl && tpl.roles));
  if (!tpl) return;

  // ── The gallery: "Yours" first ─────────────────────────────────────────────
  await win.evaluate(() => { (document.getElementById('dash-back-btn') as HTMLElement | null)?.click(); });
  await win.waitForTimeout(800);
  await win.evaluate((d: string) => (window as any).anCreateWizard(d, {}), String(sample.datasetId));
  await until(win, () => win.evaluate(() => !!document.querySelector('.an-wiz-row.is-selected')));
  await nextBtn(win);
  ok('templates: the gallery shows Yours first, then Templates and Layouts', await until(win, () => win.evaluate(() =>
    JSON.stringify([...document.querySelectorAll('.an-wiz-grouph > span:first-child')].map((g) => (g.textContent || '').trim()))
    === JSON.stringify(['Yours', 'Templates', 'Layouts']) && !!document.querySelector('.ut-yours .an-wiz-tpl'))));
  const card = await win.evaluate(() => {
    const first = document.querySelector('.an-wiz-tpl') as HTMLButtonElement;
    return {
      inYours: !!first.closest('.ut-yours'),
      name: (first.querySelector('.an-wiz-tpl-t')?.textContent || '').trim(),
      img: (first.querySelector('.an-wiz-tpl-img') as HTMLImageElement | null)?.src || '',
      blocked: first.disabled,
      more: !!first.parentElement?.querySelector('.ut-card-more'),
    };
  });
  ok('templates: the first card in the gallery is ours, with its own thumbnail and a ⋯',
    card.inYours && card.name === 'Smoke retail template' && card.img === tpl.thumbnail && !card.blocked && card.more, JSON.stringify({ ...card, img: card.img.length }));
  await shot('r7-templates-gallery.png');
  await click(win, '.ut-yours .an-wiz-tpl');
  await nextBtn(win);
  ok('templates: its mapping step is the built-ins\' — one row per role, every one mapped back',
    await until(win, async () => /6 of 6 mapped · \d+ tiles will be built/.test(await text(win, '.an-tpl-summary')), 20_000),
    await text(win, '.an-tpl-summary'));
  ok('templates: the KPI strip shows real figures', await until(win, () => win.evaluate(() => {
    const v = [...document.querySelectorAll('.an-tpl-kpi-v')].map((x) => (x.textContent || '').trim());
    return v.length === 4 && v.every((x) => x && x !== '…' && x !== '—');
  })));
  const skipped = await win.evaluate(() => {
    const row = [...document.querySelectorAll('.an-tpl-row')].find((r) => (r.querySelector('.an-tpl-role')?.childNodes[0]?.textContent || '').trim() === 'State');
    const sel = row?.querySelector('select') as HTMLSelectElement | undefined;
    if (!sel || ![...sel.options].some((o) => o.value === '')) return false;
    sel.value = '';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  ok('templates: the optional State role offers Skip', skipped);
  ok('templates: skipping it says what goes — "1 skipped"', await until(win, async () => /5 of 6 mapped · \d+ tiles will be built · 1 skipped/.test(await text(win, '.an-tpl-summary')), 15_000),
    await text(win, '.an-tpl-summary'));
  await shot('r7-templates-map.png');

  // ── Create ─────────────────────────────────────────────────────────────────
  const names0 = new Set(((await main('analyses', { pid })) as any[]).map((a) => a.id));
  await win.evaluate(() => {
    const input = document.querySelector('.an-wiz-name input') as HTMLInputElement;
    input.value = 'From my template';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await nextBtn(win);
  ok('templates: Create opens the new dashboard', await until(win, () => win.evaluate(() =>
    !document.querySelector('.an-wiz') && !!dashCurrent && dashCurrent.name === 'From my template'), 20_000));
  const created: any = ((await main('analyses', { pid })) as any[]).find((a) => !names0.has(a.id));
  const built: any = created ? await main('analysis', { pid, id: created.id }) : null;
  ok('templates: it is the sample dashboard minus the map the skipped role needed',
    !!built && built.sheets[0].cards.length === sourceCards - 1
    && built.style.density === source.style.density && built.sheets[0].cards.every((c: any) => c.action === undefined),
    `${built && built.sheets[0].cards.length} of ${sourceCards}`);
  const after: any = await main('counts', { pid, dsId: sample.datasetId });
  ok('templates: Month and the metrics were reused, not copied', after.steps === before.steps && after.metrics === before.metrics, JSON.stringify({ before, after }));
  await win.waitForTimeout(1500);
  await shot('r7-templates-built.png');

  // ── Export → delete → import ───────────────────────────────────────────────
  const file = path.join(s.userData, 'smoke-retail.ordinate-template');
  await stubDialogs(file);
  const exp: any = await win.evaluate((id: string) => (window as any).hubTemplates.exportFile(id), tpl.id);
  let parsed: any = null;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { parsed = null; }
  ok('templates: export writes one .ordinate-template file',
    !!exp && exp.ok && !!parsed && parsed.format === 'ordinate-template' && parsed.template.id === tpl.id && !('sourceAnalysisId' in parsed.template),
    JSON.stringify(exp));
  await main('dropTemplate', { id: tpl.id });
  const imp: any = await win.evaluate(() => (window as any).hubTemplates.importFile());
  const back: any[] = await main('templates');
  ok('templates: re-import brings it back under its own id, roles intact',
    !!imp && imp.ok && !imp.existed && back.some((t) => t.id === tpl.id && t.roles.length === tpl.roles.length), JSON.stringify(imp));
  const again: any = await win.evaluate(() => (window as any).hubTemplates.importFile());
  ok('templates: importing it twice merges by id, never a duplicate', !!again && again.existed === true
    && ((await main('templates')) as any[]).filter((t) => t.id === tpl.id).length === 1);

  // ── Neutral ─────────────────────────────────────────────────────────────
  await restoreDialogs();
  await win.evaluate(() => { (document.getElementById('dash-back-btn') as HTMLElement | null)?.click(); });
  await win.waitForTimeout(800);
  for (const t of (await main('templates')) as any[]) if (t.name === 'Smoke retail template') await main('dropTemplate', { id: t.id });
  if (created) await main('dropAnalysis', { pid, id: created.id });
  try { fs.rmSync(file, { force: true }); } catch (_) { /* temp */ }
  await openProject(win, fx.projectId);
  await win.evaluate(() => { if (typeof dkSetOpen === 'function') dkSetOpen(false); (window as any).selectSection('datasets'); });
  await win.waitForTimeout(600);
  ok('templates: cleaned up — no template, no dashboard left behind',
    ((await main('templates')) as any[]).length === 0 && !((await main('analyses', { pid })) as any[]).some((a) => a.name === 'From my template'));
  const errs = s.errors.slice(errors0);
  ok('templates: no renderer console error in the section', errs.length === 0, errs.join('\n'));
}
