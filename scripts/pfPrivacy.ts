// Smoke SECTION for privacy and sensitivity — drives the REAL UI of a launched
// app. Not a standalone smoke: the platform-depth runner calls
// `privacySection(s, fx)` with its own launch (smokeFixture.launchSmoke) and
// fixture (seedProject), so this adds no Electron start of its own.
//
// The walk, in the order a user meets it:
//   1. paste a table with an email and a card column → the composer flags both
//      ("Personal?" / "Financial?") and marks NOTHING on its own
//   2. accept the email proposal on its chip, save
//   3. the dataset page's banner lists what is still pending (card) → Review →
//      mark it financial
//   4. the column profile says what exports do with a marked column
//   5. "Mask in Prepare…" → a hash step → the grid shows tokens
//   6. Settings → Privacy → change a path's action, read back from main
//   7. a dashboard over the dataset → Export → "1 sensitive column will be
//      masked" in the dialog (email is masked in Prepare, so card is the one)
//   8. no renderer console error along the way (a CSP violation shows up here)
//
// Page globals: every function called below is a classic-script FUNCTION
// declaration, so it is a window property — hence `(window as any).fn(…)`,
// the same untyped reach every smoke uses; a script-level let/const would not
// be one (see the note in smokeFixture.ts), and eval is CSP-blocked.

import { ok } from './selfcheck';
const path: typeof import('path') = require('path');
import type { Smoke, Fixture } from './smokeFixture';
import { openProject, seedAnalysis, openSeededAnalysis } from './smokeFixture';

const CSV = [
  'name,email,card,region,amount',
  'Grace Hopper,grace@example.com,4111111111111111,North,10',
  'Alan Turing,alan@example.com,5555555555554444,South,20',
  'Ada Lovelace,ada@example.com,378282246310005,North,30',
  'Linus Torvalds,linus@example.com,6011111111111117,East,40',
].join('\n');
const DS_NAME = 'Privacy smoke';

export async function privacySection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errorsBefore = s.errors.length;
  // Artifacts for review. The pause lets a dialog's fade-in finish first.
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(350);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };

  await openProject(win, fx.projectId);
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(1200);

  // ── 1. Paste → composer → proposals, nothing marked ────────────────────────
  await win.click('#ds-paste-open', { timeout: 8000 });
  await win.waitForSelector('#ds-import-modal:not([hidden])', { timeout: 8000 });
  await win.fill('#ds-paste-input', CSV);
  await win.click('#ds-paste-parse', { timeout: 8000 });
  await win.waitForSelector('#ds-composer:not([hidden])', { timeout: 15_000 });
  await win.waitForSelector('#dc-grid .pv-chip', { timeout: 10_000 }).catch(() => {});
  const chips: string[] = await win.evaluate(() =>
    [...document.querySelectorAll('#dc-grid .dc-th')].map((th) => {
      const chip = th.querySelector('.pv-chip');
      return (th.querySelector('.dc-th-name')?.textContent || '') + ':' + (chip ? chip.textContent : '');
    }));
  ok('privacy: the composer flags email as Personal? and card as Financial?',
    chips.includes('email:Personal?') && chips.includes('card:Financial?'), chips.join(' | '));
  ok('privacy: region and amount carry no chip', chips.includes('region:') && chips.includes('amount:'), chips.join(' | '));

  // ── 2. Accept email on its chip; leave card for later; save ───────────────
  await win.evaluate(() => {
    const th = [...document.querySelectorAll('#dc-grid .dc-th')].find((t) => t.querySelector('.dc-th-name')?.textContent === 'email');
    (th?.querySelector('.pv-chip') as HTMLElement | null)?.click();
  });
  await win.waitForSelector('.chart-menu.pv-pop', { timeout: 5000 });
  await shot('privacy-composer-proposal.png');
  ok('privacy: the chip opens the proposal with its reason',
    /Looks like email addresses/.test((await win.locator('.pv-pop-title').textContent()) || '') && /4 of 4 sampled values/.test((await win.locator('.pv-pop-reason').textContent()) || ''));
  await win.evaluate(() => {
    const item = [...document.querySelectorAll('.pv-pop .chart-menu-item')].find((b) => b.textContent === 'Mark as personal') as HTMLElement | undefined;
    item?.click();
  });
  await win.waitForTimeout(300);
  ok('privacy: the accepted chip now reads Personal (set)',
    await win.evaluate(() => !!document.querySelector('#dc-grid .pv-chip.is-set.pv-chip--personal')));
  await win.fill('#dc-name', DS_NAME);
  await win.click('#dc-save', { timeout: 8000 });
  await win.waitForSelector('#ds-composer', { state: 'hidden', timeout: 20_000 }).catch(() => {});
  await win.waitForTimeout(1200);

  const saved: any = await app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const catalog = req('./src/app/catalog.js');
    const list = await datasets.listDatasets(arg.pid);
    const d = list.find((x: any) => x.name === arg.name);
    if (!d) return null;
    const docs = await catalog.getColumns(arg.pid, d.id);
    return { id: d.id, email: docs.email ? docs.email.sensitivity : 'none', card: docs.card ? docs.card.sensitivity : 'none' };
  }, { pid: fx.projectId, name: DS_NAME });
  ok('privacy: the dataset saved', !!saved && !!saved.id, JSON.stringify(saved));
  ok('privacy: the accepted proposal was written (email personal); the undecided one was NOT (card none)',
    !!saved && saved.email === 'personal' && saved.card === 'none', JSON.stringify(saved));
  if (!saved) return;

  // ── 3. Dataset page banner → Review → mark card financial ─────────────────
  await win.evaluate((id: string) => (window as any).openSavedDataset(id), saved.id);
  await win.waitForSelector('#pv-review-banner:not([hidden])', { timeout: 10_000 }).catch(() => {});
  const banner: string = await win.evaluate(() => document.getElementById('pv-review-banner')?.textContent || '');
  ok('privacy: the dataset page says what still looks sensitive', /look(s)? sensitive/.test(banner) && banner.includes('card'), banner);
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('#pv-review-banner button')].find((x) => x.textContent === 'Review') as HTMLElement | undefined;
    b?.click();
  });
  await win.waitForTimeout(300);
  await shot('privacy-dataset-review.png');
  const clicked = await win.evaluate(() => {
    const row = [...document.querySelectorAll('#pv-review-banner .pv-review-row')].find((r) => r.querySelector('.pv-review-col')?.textContent === 'card');
    const btn = row ? [...row.querySelectorAll('button')].find((b) => b.textContent === 'Mark as financial') as HTMLElement | undefined : undefined;
    btn?.click();
    return !!btn;
  });
  ok('privacy: Review lists card with a Mark as financial button', clicked);
  await win.waitForTimeout(1200);
  const card: string = await app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const docs = await req('./src/app/catalog.js').getColumns(arg.pid, arg.id);
    return docs.card ? docs.card.sensitivity : 'none';
  }, { pid: fx.projectId, id: saved.id });
  ok('privacy: marking from the banner writes the catalog level', card === 'financial', card);

  // ── 4. The column profile ─────────────────────────────────────────────────
  await win.evaluate(() => {
    const i = [...document.querySelectorAll('#ds-explorer-scroll .ds-th')].findIndex((th) => (th.textContent || '').trim().startsWith('email'));
    (window as any).dsOpenProfile(i >= 0 ? i : 1);
  });
  await win.waitForSelector('#ds-profile .js-dsp-privacy:not([hidden])', { timeout: 8000 }).catch(() => {});
  await shot('privacy-profile.png');
  const prof: string = await win.evaluate(() => (document.querySelector('#ds-profile .js-dsp-privacy') as HTMLElement | null)?.textContent || '');
  ok('privacy: the profile says the column is personal and what exports do', /Personal data/.test(prof) && /mask/i.test(prof), prof);

  // ── 5. Mask in Prepare → tokens in the grid ───────────────────────────────
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('#ds-profile .js-dsp-privacy button')].find((x) => /Mask in Prepare/.test(x.textContent || '')) as HTMLElement | undefined;
    b?.click();
  });
  await win.waitForSelector('#ds-step-editor:not([hidden])', { timeout: 8000 }).catch(() => {});
  const editor: string = await win.evaluate(() => {
    const ed = document.getElementById('ds-step-editor');
    const sel = ed?.querySelector('select') as HTMLSelectElement | null;
    return (ed?.querySelector('.ds-step-editor-title')?.textContent || '') + '|' + (sel ? sel.value : '');
  });
  ok('privacy: the editor opens on a hash step for that column', /Mask — hash/.test(editor) && editor.endsWith('|email'), editor);
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('#ds-step-editor button')].find((x) => x.textContent === 'Save step') as HTMLElement | undefined;
    b?.click();
  });
  await win.waitForTimeout(2500);
  await shot('privacy-masked-grid.png');
  const cells: string[] = await win.evaluate(() => {
    const ths = [...document.querySelectorAll('#ds-explorer-scroll thead th')];
    const i = ths.findIndex((th) => (th.textContent || '').trim().startsWith('email'));
    return [...document.querySelectorAll('#ds-explorer-scroll tbody tr')].map((tr) => (tr.children[i]?.textContent || '').trim());
  });
  ok('privacy: the grid shows project tokens where the emails were',
    cells.length === 4 && cells.every((c) => /^#[0-9a-f]{12}$/.test(c)), cells.join(' | '));

  // ── 6. Settings → Privacy ─────────────────────────────────────────────────
  await win.evaluate(() => (window as any).showSettingsPanel('privacy'));
  await win.waitForSelector('#stp-privacy .pv-policy', { timeout: 8000 }).catch(() => {});
  await shot('privacy-settings.png');
  const pane: string = await win.evaluate(() => document.getElementById('stp-privacy')?.textContent || '');
  ok('privacy: Settings → Privacy names the project and lists the four paths',
    pane.includes('Share policy for “Smoke test”') && ['Exports', 'Reports and stories', 'Publish', 'Project bundles'].every((t) => pane.includes(t)), pane.slice(0, 200));
  ok('privacy: …and the marked columns, email noted as masked in Prepare', pane.includes('masked in Prepare') && pane.includes('card'));
  await win.evaluate(() => {
    const row = [...document.querySelectorAll('#stp-privacy .pv-policy .stp-row')].find((r) => r.querySelector('.stp-rt')?.textContent === 'Reports and stories');
    const drop = row ? [...row.querySelectorAll('.stp-seg-opt')].find((b) => b.textContent === 'Drop') as HTMLElement | undefined : undefined;
    drop?.click();
  });
  await win.waitForTimeout(600);
  const policy: any = await app.evaluate(async (_e, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/app/privacyStore.js').getPolicy(pid);
  }, fx.projectId);
  ok('privacy: the policy change is stored in main (reports → drop, exports still mask)', policy.report === 'drop' && policy.export === 'mask', JSON.stringify(policy));
  await win.keyboard.press('Escape');
  await win.waitForTimeout(400);

  // ── 7. The dashboard export dialog carries the line ───────────────────────
  const visualId: string = await app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const v = await req('./src/analysis/visuals.js').saveVisual(arg.pid, {
      datasetId: arg.id, name: 'Amount by card', chartType: 'column',
      encoding: { category: 'card', values: [{ column: 'amount', aggregation: 'sum' }] },
    });
    return v ? v.id : '';
  }, { pid: fx.projectId, id: saved.id });
  await seedAnalysis(app, fx.projectId, { name: 'Privacy board', sheets: [{ name: 'Sheet 1', cards: [{ type: 'visual', visualId, layout: { x: 0, y: 0, w: 6, h: 4 } }] }] });
  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.waitForTimeout(1500);
  const opened = await openSeededAnalysis(win, 'Privacy board');
  ok('privacy: the dashboard opened', opened);
  await win.evaluate(() => { void (window as any).handleDashExport(); });
  await win.waitForSelector('.ws-modal .pv-share-note:not([hidden])', { timeout: 10_000 }).catch(() => {});
  await shot('privacy-export-dialog.png');
  const line: string = await win.evaluate(() => (document.querySelector('.ws-modal .pv-share-note') as HTMLElement | null)?.textContent || '');
  ok('privacy: the export dialog says "1 sensitive column will be masked" with a Change link',
    /1 sensitive column will be masked/.test(line) && /Change/.test(line), line);
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);

  // Main's side of the same export: the chart the file would draw is masked.
  const shaped: any = await app.evaluate(async (_e, arg: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const share = req('./src/app/sharePolicy.js');
    return share.applyToChart(arg.pid, arg.id, { category: 'card', values: [{ column: 'amount', aggregation: 'sum' }] },
      { ok: true, data: { labels: ['4111111111111111'], series: [{ name: 'sum(amount)', values: [10] }] } }, 'export');
  }, { pid: fx.projectId, id: saved.id });
  ok('privacy: the exported chart labels are tokens, not card numbers', shaped.ok && /^#[0-9a-f]{12}$/.test(shaped.data.labels[0]), JSON.stringify(shaped));

  const newErrors = s.errors.slice(errorsBefore);
  ok('privacy: no renderer console error in the whole section', newErrors.length === 0, newErrors.join('\n'));
}
