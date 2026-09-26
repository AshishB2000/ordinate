// Workflow smoke, section 2 — Stories.
//
// Through the real UI: the Stories tab → New story → `/` in the empty line
// inserts a text block (a heading and a line of prose) and then a visual block
// picked from the sample's charts → the outline shows the heading → ⌘Z / ⌘⇧Z
// walk the shared history → present mode pages by heading → Export PDF writes
// a real PDF with a page per heading. Then the Assistant's story action:
// outline proposed, reviewed, built into a story that opens.

import { ok } from './selfcheck';
import type { Smoke } from './smokeFixture';
import { domDriver } from './smokeFixture';
import { queueReplies } from './wfStub';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

export async function storiesSection(s: Smoke, ids: { projectId: string; datasetId: string }): Promise<void> {
  const { win } = s;
  const d = domDriver(win);
  await win.evaluate(async () => {
    const w = window as any;
    if (w.dashCurrent) await w.handleBackToList();
    w.dkSetOpen(false);
    w.selectSection('analyses');
  });
  await win.waitForTimeout(800);
  await d.clickId('rp-tab-stories');
  await win.waitForTimeout(600);
  const tab = await win.evaluate(() => ({
    selected: document.getElementById('rp-tab-stories')?.getAttribute('aria-selected'),
    panel: !(document.getElementById('st-list-wrap') as HTMLElement).hidden,
    emptyShown: !(document.getElementById('st-empty') as HTMLElement).hidden,
    dashTable: !(document.getElementById('an-table') as HTMLElement).hidden,
  }));
  ok('stories: a third tab beside Dashboards and Reports, showing its empty state',
    tab.selected === 'true' && tab.panel && tab.emptyShown && !tab.dashTable, JSON.stringify(tab));
  await win.screenshot({ path: path.join(s.shotDir, 'wf-2-stories-empty.png') });

  // ── New story ──────────────────────────────────────────────────────────────
  await d.clickId('st-empty-new');
  await win.waitForTimeout(300);
  await d.fillPrompt('Q4 review');
  await win.waitForSelector('#st-page:not([hidden]) #st-doc .st-block', { timeout: 10_000 });
  await win.waitForTimeout(300);

  // `/` in the (focused) empty last line → the picker → Text.
  const typeSlash = async (): Promise<void> => {
    await win.keyboard.type('/');
    await win.waitForSelector('.st-picker', { timeout: 5000 });
  };
  await typeSlash();
  const pickerRows = await win.evaluate(() => [...document.querySelectorAll('.st-picker .st-picker-row')].map((r) => (r as HTMLElement).dataset.kind));
  ok('stories: / in an empty line opens the block picker with every kind',
    JSON.stringify(pickerRows) === JSON.stringify(['text', 'heading', 'visual', 'metric', 'metrics_row', 'image', 'divider', 'callout']),
    JSON.stringify(pickerRows));
  await win.screenshot({ path: path.join(s.shotDir, 'wf-2-picker.png') });
  await win.click('.st-picker .st-picker-row[data-kind="text"]');
  await win.waitForTimeout(200);
  await win.keyboard.type('## Revenue by category');
  await win.keyboard.press('Enter');
  await win.keyboard.type('Technology carries **most** of it.');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(400);

  const outline1 = await win.evaluate(() => [...document.querySelectorAll('#st-outline-list .st-outline-link')].map((a) => (a.textContent || '').trim()));
  ok('stories: the outline shows the headings', JSON.stringify(outline1) === '["Q4 review","Revenue by category"]', JSON.stringify(outline1));
  const rendered = await win.evaluate(() => {
    const h2 = [...document.querySelectorAll('#st-doc .st-h2')].map((h) => (h.textContent || '').trim());
    const strong = [...document.querySelectorAll('#st-doc .st-md strong')].map((h) => (h.textContent || '').trim());
    return { h2, strong };
  });
  ok('stories: the text block renders its Markdown', rendered.h2.includes('Revenue by category') && rendered.strong.includes('most'), JSON.stringify(rendered));

  // The new trailing empty line → / → Chart → the sample's category chart.
  await win.evaluate(() => {
    const blocks = [...document.querySelectorAll('#st-doc .st-block')];
    const last = blocks[blocks.length - 1];
    (last.querySelector('.is-editable') as HTMLElement).click();
  });
  await win.waitForTimeout(200);
  await typeSlash();
  await win.click('.st-picker .st-picker-row[data-kind="visual"]');
  await win.waitForSelector('.st-chooser .st-chooser-row', { timeout: 5000 });
  const choices = await win.evaluate(() => [...document.querySelectorAll('.st-chooser .st-chooser-label')].map((r) => (r.textContent || '').trim()));
  ok('stories: the chart picker lists the project\'s saved visuals', choices.includes('Revenue by category'), JSON.stringify(choices));
  await win.evaluate(() => {
    const row = [...document.querySelectorAll('.st-chooser .st-chooser-row')]
      .find((r) => (r.querySelector('.st-chooser-label')?.textContent || '').trim() === 'Revenue by category') as HTMLElement;
    row.click();
  });
  await win.waitForSelector('#st-doc .st-block--visual .st-chart canvas', { timeout: 15_000 });
  await win.waitForTimeout(1500);
  const vis = await win.evaluate(() => {
    const fig = document.querySelector('#st-doc .st-block--visual') as HTMLElement;
    const c = fig.querySelector('canvas') as HTMLCanvasElement;
    return {
      title: (fig.querySelector('.st-fig-title')?.textContent || '').trim(),
      w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height,
      caption: (fig.querySelector('.st-caption') as HTMLInputElement).placeholder,
      tail: (() => { const all = [...document.querySelectorAll('#st-doc .st-block')]; return all[all.length - 1].className; })(),
    };
  });
  ok('stories: the visual block draws the live chart', vis.title === 'Revenue by category' && vis.w > 200 && vis.h > 100, JSON.stringify(vis));
  ok('stories: …captioned by the app unless the author writes one', /^Technology leads revenue/.test(vis.caption), vis.caption);
  ok('stories: …and the page still ends on an empty line to type into', /st-block--text/.test(vis.tail), vis.tail);
  await win.waitForTimeout(900); // the debounced save

  const saved = await win.evaluate(async (pid: string) => {
    const w = window as any;
    const list = await w.hub.listStories(pid);
    const st = await w.hub.getStory(pid, list[0].id);
    const visuals = await w.hub.listVisuals(pid);
    const cat = visuals.find((v: any) => v.name === 'Revenue by category');
    return { count: list.length, kinds: st.blocks.map((b: any) => b.kind), visualOk: st.blocks.some((b: any) => b.kind === 'visual' && b.visualId === cat.id), id: st.id };
  }, ids.projectId);
  ok('stories: saved — a heading/prose block and a LIVE reference to the chart',
    saved.count === 1 && saved.visualOk && saved.kinds.filter((k: string) => k === 'text').length >= 2, JSON.stringify(saved));
  await win.screenshot({ path: path.join(s.shotDir, 'wf-2-story.png') });

  // ── ⌘Z through the shared history ──────────────────────────────────────────
  await win.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await win.keyboard.press(`${MOD}+z`);
  await win.waitForTimeout(400);
  const undone = await win.evaluate(() => document.querySelectorAll('#st-doc .st-block--visual').length);
  await win.keyboard.press(`${MOD}+Shift+z`);
  await win.waitForTimeout(800);
  const redone = await win.evaluate(() => document.querySelectorAll('#st-doc .st-block--visual canvas').length);
  ok('stories: ⌘Z takes the chart back out, ⌘⇧Z puts it back', undone === 0 && redone === 1, JSON.stringify({ undone, redone }));

  // ── Present, a page per heading ────────────────────────────────────────────
  await d.clickId('st-present');
  await win.waitForSelector('#st-present-view:not([hidden]) .st-present-h', { timeout: 10_000 });
  const p1 = await win.evaluate(() => ({
    h: (document.querySelector('#st-present-page .st-present-h')?.textContent || '').trim(),
    count: (document.getElementById('st-present-count')?.textContent || '').trim(),
    topbar: getComputedStyle(document.querySelector('.hub-topbar') as HTMLElement).display,
  }));
  await win.keyboard.press('ArrowRight');
  await win.waitForSelector('#st-present-page .st-chart canvas', { timeout: 10_000 });
  await win.waitForTimeout(800);
  const p2 = await win.evaluate(() => ({
    h: (document.querySelector('#st-present-page .st-present-h')?.textContent || '').trim(),
    count: (document.getElementById('st-present-count')?.textContent || '').trim(),
    prose: (document.querySelector('#st-present-page .st-md')?.textContent || '').trim(),
  }));
  ok('present: page 1 is the title section, full window', p1.h === 'Q4 review' && p1.count === '1 / 2' && p1.topbar === 'none', JSON.stringify(p1));
  ok('present: → pages to the next heading, with its prose and its chart',
    p2.h === 'Revenue by category' && p2.count === '2 / 2' && /Technology carries most of it/.test(p2.prose), JSON.stringify(p2));
  await win.screenshot({ path: path.join(s.shotDir, 'wf-2-present.png') });
  await win.keyboard.press('Escape');
  await win.waitForTimeout(300);
  ok('present: Escape leaves', await win.evaluate(() => (document.getElementById('st-present-view') as HTMLElement).hidden === true));

  // ── Export PDF → a real file, a page per heading ───────────────────────────
  const dest = path.join(s.userData, 'q4-review.pdf');
  await s.app.evaluate(async (_a: unknown, file: string) => {
    const electron = (process as any).mainModule.require('electron');
    electron.dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
  }, dest);
  await d.clickId('st-export');
  for (let i = 0; i < 40 && !fs.existsSync(dest); i++) await win.waitForTimeout(500);
  const pdf = fs.existsSync(dest) ? fs.readFileSync(dest) : Buffer.alloc(0);
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  ok('export: Export PDF writes a PDF', pdf.slice(0, 5).toString() === '%PDF-', String(pdf.length));
  ok('export: …with one page per heading', pages === 2, String(pages));

  // ── The Assistant's story action: outline → review → build ────────────────
  await s.app.evaluate(async (_a: unknown, plan: any) => { (globalThis as any).__wf.plan = plan; }, {
    name: 'Regional performance',
    rationale: 'Where revenue comes from, then how profit follows it.',
    calculatedFields: [],
    sheets: [
      { name: 'Revenue by region', metrics: [{ dataset: 'Retail orders', column: 'revenue', aggregation: 'sum', label: 'Revenue' }],
        visuals: [{ dataset: 'Retail orders', name: 'Revenue by region', chartType: 'column',
          encoding: { category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] } }],
        texts: [{ heading: 'What to look at', text: 'West and East carry the year.' }] },
      { name: 'Profit follows', metrics: [],
        visuals: [{ dataset: 'Retail orders', name: 'Profit by region', chartType: 'bar',
          encoding: { category: 'region', values: [{ column: 'profit', aggregation: 'sum' }] } }],
        texts: [] },
    ],
  });
  await queueReplies(s, [{ text: 'Here is an outline for a story about regional performance.', action: { kind: 'story', intent: 'a story about regional performance' } }]);
  await win.evaluate(async () => {
    const w = window as any;
    w.dkSetOpen(true);
    await w.dkRefresh();
    const input = document.getElementById('dk-input') as HTMLTextAreaElement;
    input.value = 'write me a story about regional performance';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await win.focus('#dk-input');
  await win.keyboard.press('Enter');
  await win.waitForSelector('#dk-messages .st-proposal', { timeout: 30_000 });
  await win.waitForTimeout(1500);
  const prop = await win.evaluate(() => {
    const card = document.querySelector('#dk-messages .st-proposal') as HTMLElement;
    return {
      name: (card.querySelector('.dk-plan-name')?.textContent || '').trim(),
      sections: [...card.querySelectorAll('.st-prop-h')].map((h) => (h.textContent || '').trim()),
      charts: card.querySelectorAll('.an-draft-visual').length,
      buttons: [...card.querySelectorAll('button')].map((b) => (b.textContent || '').trim()),
    };
  });
  ok('story action: the proposal is an OUTLINE — sections with their charts previewed',
    prop.name === 'Regional performance' && JSON.stringify(prop.sections) === '["Revenue by region","Profit follows"]' && prop.charts === 2,
    JSON.stringify(prop));
  await win.screenshot({ path: path.join(s.shotDir, 'wf-2-proposal.png') });
  await win.evaluate(() => {
    const card = document.querySelector('#dk-messages .st-proposal') as HTMLElement;
    ([...card.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Build story') as HTMLElement).click();
  });
  await win.waitForFunction(() => (document.getElementById('st-name') as HTMLInputElement | null)?.value === 'Regional performance'
    && !(document.getElementById('st-page') as HTMLElement).hidden, undefined, { timeout: 20_000 });
  await win.waitForTimeout(1500);
  const built = await win.evaluate(() => ({
    outline: [...document.querySelectorAll('#st-outline-list .st-outline-link')].map((a) => (a.textContent || '').trim()),
    charts: document.querySelectorAll('#st-doc .st-block--visual canvas').length,
    kpis: [...document.querySelectorAll('#st-doc .st-metric-name')].map((n) => (n.textContent || '').trim()),
  }));
  ok('story action: Build opens the new story — a section per sheet, live charts, the KPI',
    JSON.stringify(built.outline) === '["Regional performance","Revenue by region","What to look at","Profit follows"]'
    && built.charts === 2 && built.kpis.includes('Revenue'), JSON.stringify(built));
  await win.evaluate(() => { (window as any).dkSetOpen(false); });
}
