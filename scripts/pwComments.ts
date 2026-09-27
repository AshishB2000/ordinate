// Smoke SECTION: comments and annotations, in the real app.
//
// Not a smoke file of its own: `commentsSection(s, ids)` runs against an app
// someone else launched, on a FRESH userData whose first-launch sample is
// seeded ("My project" / "Retail orders" / "Retail overview"). It drives what a
// user does:
//
//   1. a card head's comment icon → the thread panel's empty state
//   2. post a comment written in Markdown (⌘↩), reply, resolve, reopen —
//      the card head's count following each step
//   3. the dashboard head's Comments toggle: every thread, Open / Resolved / All
//   4. ⌘-click a bar → the composer pinned to that point → a comment whose
//      `point` is the bar's label, and the chart rebuilt with the pin
//      (the pin's DRAWING belongs to the annotations plugin, checked elsewhere)
//   5. Home's "Recent comments" row, and a row opening its thread
//
// What is on disk is read back through main's own store, never inferred from
// the DOM alone.

import { ok } from './selfcheck';
import type { Smoke } from './smokeFixture';

// The hub's own globals, read inside page.evaluate by their bare names: a
// top-level const/let of a classic script is not a property of window.
declare const chartInstances: WeakMap<Element, any>;
declare const cmtPinsDrawn: Map<string, string>;
declare function cmtWithPins(overrides: any, kind: string, id: string): any;

type Win = Smoke['win'];
const CARD = 'Revenue by category';

/** Main's stored threads for the project — the store, not the page. */
async function stored(s: Smoke, projectId: string): Promise<any[]> {
  return s.app.evaluate(async (_e, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const res = await req('./src/app/comments.js').list(pid);
    return res.ok ? res.comments : [];
  }, projectId);
}

/** The card's head button: its accessible name and visible count. */
async function cardButton(win: Win): Promise<{ id: string; label: string; count: string }> {
  return win.evaluate((title: string) => {
    const card = [...document.querySelectorAll('#dash-grid .dash-card')]
      .find((c) => (c.querySelector('.dash-card-title')?.textContent || '').trim() === title) as HTMLElement | undefined;
    const btn = card?.querySelector('.cmt-card-btn') as HTMLElement | null;
    return { id: card?.dataset.cardId || '', label: btn?.getAttribute('aria-label') || '', count: (btn?.querySelector('.cmt-count')?.textContent || '').trim() };
  }, CARD);
}

async function clickIn(win: Win, selector: string, text: string): Promise<boolean> {
  const done = await win.evaluate((a: { selector: string; text: string }) => {
    const el = [...document.querySelectorAll(a.selector)].find((b) => (b.textContent || '').trim() === a.text) as HTMLElement | undefined;
    if (!el) return false;
    el.click();
    return true;
  }, { selector, text });
  await win.waitForTimeout(500);
  return done;
}

async function panel(win: Win): Promise<{ open: boolean; target: string; threads: number; resolved: number; empty: string; filter: string[] }> {
  return win.evaluate(() => {
    const p = document.querySelector('aside.ws-side[data-kind="comments"]') as HTMLElement | null;
    return {
      open: !!p,
      target: p?.dataset.target || '',
      threads: p ? p.querySelectorAll('.cmt-thread').length : 0,
      resolved: p ? p.querySelectorAll('.cmt-thread.is-resolved').length : 0,
      empty: (p?.querySelector('.ws-empty-h')?.textContent || '').trim(),
      filter: p ? [...p.querySelectorAll('.cmt-filter-opt')].map((b) => [...b.children].map((x) => (x.textContent || '').trim()).join(' ')) : [],
    };
  });
}

export async function commentsSection(s: Smoke, ids: { projectId: string; datasetId: string; dashboardId: string }): Promise<void> {
  const { win } = s;
  await win.evaluate(async (a: { projectId: string; dashboardId: string }) => {
    const w = window as any;
    await w.adoptProject(a.projectId);
    w.selectSection('analyses');
    await w.openAnalysis(a.dashboardId);
  }, ids);
  await win.waitForTimeout(3500);
  await win.mouse.click(5, 300); // any click ends the sample's first-open coach-mark tour

  // ── 1. the card head's icon ────────────────────────────────────────────────
  const b0 = await cardButton(win);
  ok('comments: the card head carries a comment icon named "Comments (0)"', !!b0.id && b0.label === 'Comments (0)' && b0.count === '', JSON.stringify(b0));
  await win.hover(`#dash-grid .dash-card[data-card-id="${b0.id}"] .dash-card-head`);
  await win.click(`#dash-grid .dash-card[data-card-id="${b0.id}"] .cmt-card-btn`);
  await win.waitForTimeout(500);
  const p0 = await panel(win);
  ok('comments: the icon opens the right panel on that card, empty state first',
    p0.open && p0.target === 'card:' + b0.id && /No comments yet/.test(p0.empty), JSON.stringify(p0));

  // ── 2. post (Markdown, ⌘↩), reply, resolve, reopen ─────────────────────────
  const input = 'aside[data-kind="comments"] .cmt-foot .cmt-input';
  await win.fill(input, 'Is **Technology** net of returns? See [the brief](https://example.com/brief)');
  await win.press(input, 'Meta+Enter');
  await win.waitForSelector('aside[data-kind="comments"] .cmt-thread', { timeout: 10_000 });
  const posted = await win.evaluate(() => {
    const t = document.querySelector('aside[data-kind="comments"] .cmt-thread') as HTMLElement;
    return {
      bold: (t.querySelector('.cmt-body strong')?.textContent || '').trim(),
      href: t.querySelector('.cmt-body a')?.getAttribute('href') || '',
      author: (t.querySelector('.cmt-author')?.textContent || '').trim(),
      composer: (document.querySelector('aside[data-kind="comments"] .cmt-foot .cmt-input') as HTMLTextAreaElement).value,
    };
  });
  ok('comments: ⌘↩ posts; the body renders the Markdown subset (bold, a safe link)',
    posted.bold === 'Technology' && posted.href === 'https://example.com/brief' && !!posted.author && posted.composer === '', JSON.stringify(posted));
  let disk = await stored(s, ids.projectId);
  ok('comments: stored on the card, author resolved in main',
    disk.length === 1 && disk[0].target.kind === 'card' && disk[0].target.id === b0.id && /\*\*Technology\*\*/.test(disk[0].body) && disk[0].author === posted.author,
    JSON.stringify(disk));
  const b1 = await cardButton(win);
  ok('comments: the card head counts one open thread', b1.label === 'Comments (1)' && b1.count === '1', JSON.stringify(b1));

  ok('comments: Reply opens a reply box', await clickIn(win, 'aside[data-kind="comments"] .cmt-act', 'Reply'));
  await win.fill('aside[data-kind="comments"] .cmt-reply-box .cmt-input', 'Yes — returns are netted out upstream.');
  await clickIn(win, 'aside[data-kind="comments"] .cmt-reply-box .btn-primary', 'Reply');
  const replies = await win.evaluate(() => [...document.querySelectorAll('aside[data-kind="comments"] .cmt-reply .cmt-body')].map((b) => (b.textContent || '').trim()));
  ok('comments: the reply shows under the thread', replies.length === 1 && /netted out/.test(replies[0]), JSON.stringify(replies));

  await clickIn(win, 'aside[data-kind="comments"] .cmt-act', 'Resolve');
  const p1 = await panel(win);
  const b2 = await cardButton(win);
  ok('comments: Resolve marks the thread resolved and the card count drops to 0',
    p1.resolved === 1 && b2.label === 'Comments (0)' && b2.count === '', JSON.stringify({ p1, b2 }));
  await clickIn(win, 'aside[data-kind="comments"] .cmt-act', 'Reopen');
  const b3 = await cardButton(win);
  disk = await stored(s, ids.projectId);
  ok('comments: Reopen brings it back — count 1, stored open with its reply',
    b3.label === 'Comments (1)' && !disk[0].resolvedAt && disk[0].replies.length === 1, JSON.stringify({ b3, disk }));

  // ── 3. the dashboard head's toggle ─────────────────────────────────────────
  const toggle = await win.evaluate(() => document.getElementById('dash-comments-btn')?.getAttribute('aria-label') || '');
  ok('comments: the dashboard head has a Comments toggle counting open threads', toggle === 'Comments (1)', toggle);
  await win.click('#dash-comments-btn');
  await win.waitForTimeout(500);
  let pa = await panel(win);
  const onCard = await win.evaluate(() => (document.querySelector('aside[data-kind="comments"] .cmt-on')?.textContent || '').trim());
  ok('comments: the toggle lists every thread on the dashboard, each linked to its card',
    pa.target.startsWith('analysis:') && pa.threads === 1 && onCard === 'on ' + CARD, JSON.stringify({ pa, onCard }));
  await win.fill(input, 'Dashboard-wide: *Q4* numbers land Friday.');
  await win.press(input, 'Meta+Enter');
  await win.waitForTimeout(600);
  pa = await panel(win);
  ok('comments: a comment on the dashboard itself joins the list', pa.threads === 2 && pa.filter[0] === 'Open 2', JSON.stringify(pa));
  await win.evaluate(() => {
    const t = [...document.querySelectorAll('aside[data-kind="comments"] .cmt-thread')].find((x) => /Q4/.test(x.textContent || ''));
    ([...(t?.querySelectorAll('.cmt-act') || [])].find((b) => (b.textContent || '').trim() === 'Resolve') as HTMLElement | undefined)?.click();
  });
  await win.waitForTimeout(600);
  pa = await panel(win);
  ok('comments: the filter counts Open 1 · Resolved 1 · All 2, showing Open', JSON.stringify(pa.filter) === JSON.stringify(['Open 1', 'Resolved 1', 'All 2']) && pa.threads === 1, JSON.stringify(pa));
  await win.click('aside[data-kind="comments"] .cmt-filter-opt[data-filter="resolved"]');
  await win.waitForTimeout(300);
  const onlyResolved = await panel(win);
  await win.click('aside[data-kind="comments"] .cmt-filter-opt[data-filter="all"]');
  await win.waitForTimeout(300);
  const everything = await panel(win);
  ok('comments: Resolved shows the resolved thread only; All shows both',
    onlyResolved.threads === 1 && onlyResolved.resolved === 1 && everything.threads === 2, JSON.stringify({ onlyResolved, everything }));
  await win.click('#dash-comments-btn'); // the toggle closes it again
  await win.waitForTimeout(300);
  ok('comments: the toggle closes the panel', !(await panel(win)).open);

  // ── 4. ⌘-click a bar → a pinned comment ────────────────────────────────────
  const bar = await win.evaluate((id: string) => {
    const area = document.querySelector(`#dash-grid .dash-card[data-card-id="${id}"] .cv-viz-area`) as HTMLElement | null;
    const chart = area ? chartInstances.get(area) : null;
    const el = chart && chart.getDatasetMeta(0).data[0];
    if (!el) return null;
    const c = el.getCenterPoint(); // CSS px from the canvas's top-left — what a click position is
    return { x: Math.round(c.x), y: Math.round(c.y), label: String(chart.data.labels[0]) };
  }, b0.id);
  ok('comments: the category chart drew bars to click', !!bar, JSON.stringify(bar));
  if (!bar) return;
  await win.click(`#dash-grid .dash-card[data-card-id="${b0.id}"] .cv-viz-area canvas`, { position: { x: bar.x, y: bar.y }, modifiers: ['Meta'] });
  await win.waitForTimeout(600);
  const pinChip = await win.evaluate(() => (document.querySelector('aside[data-kind="comments"] .cmt-compose-pin strong')?.textContent || '').trim());
  const drill = await win.evaluate(() => [...document.querySelectorAll('.drill-backdrop')].some((b) => !(b as HTMLElement).hidden));
  ok('comments: ⌘-click opens the composer pinned to that bar (and does not drill)', pinChip === bar.label && !drill, JSON.stringify({ pinChip, label: bar.label, drill }));
  await win.fill(input, 'This bar looks high for the quarter.');
  await win.press(input, 'Meta+Enter');
  await win.waitForTimeout(2500); // the card rebuilds its chart with the new pin
  disk = await stored(s, ids.projectId);
  const pinned = disk.find((c) => c.target.point);
  ok('comments: the stored comment carries the point',
    !!pinned && pinned.target.kind === 'card' && pinned.target.id === b0.id && pinned.target.point.label === bar.label, JSON.stringify(pinned));
  const drawn = await win.evaluate((id: string) => {
    const pins = JSON.parse(cmtPinsDrawn.get('card:' + id) || '[]');
    const chip = (document.querySelector('aside[data-kind="comments"] .cmt-pin')?.textContent || '').trim();
    // What buildChart is handed: the pins, and where a pin click routes (the annotations plugin's contract).
    const ov = cmtWithPins({ valueMode: 'all' }, 'card', id);
    return { pins, chip, target: ov.commentPinTarget, kept: ov.valueMode, sameList: JSON.stringify(ov.commentPins) === JSON.stringify(pins) };
  }, b0.id);
  ok('comments: the chart was rebuilt with commentPins [{ n: 1, id, label }] and the thread shows "#1"',
    drawn.pins.length === 1 && drawn.pins[0].n === 1 && drawn.pins[0].id === (pinned && pinned.id) && drawn.pins[0].label === bar.label && drawn.chip === '#1',
    JSON.stringify(drawn));
  ok('comments: …with commentPinTarget { kind: "card", id } beside them, the chart\'s own overrides kept',
    !!drawn.target && drawn.target.kind === 'card' && drawn.target.id === b0.id && drawn.kept === 'all' && drawn.sameList, JSON.stringify(drawn));
  const b4 = await cardButton(win);
  ok('comments: the card head now counts two open threads', b4.label === 'Comments (2)', JSON.stringify(b4));

  // ── 5. Home's "Recent comments" ────────────────────────────────────────────
  await win.evaluate(async () => {
    const w = window as any;
    await w.handleBackToList();
    w.selectSection('home');
    await w.renderRecent();
  });
  await win.waitForTimeout(1200);
  const home = await win.evaluate(() => {
    const sec = document.getElementById('home-comments') as HTMLElement | null;
    return {
      shown: !!sec && !sec.hidden,
      count: (sec?.querySelector('.home-sec-count')?.textContent || '').trim(),
      cards: sec ? [...sec.querySelectorAll('.cmt-home-card')].map((c) => ({
        snippet: (c.querySelector('.cmt-home-snippet')?.textContent || '').trim(),
        on: (c.querySelector('.cmt-home-on')?.textContent || '').trim(),
      })) : [],
    };
  });
  ok('comments: Home shows "Recent comments" while threads are open — newest first, named for their card',
    home.shown && home.count === '2 open' && home.cards.length === 2 && /bar looks high/.test(home.cards[0].snippet) && home.cards[0].on.startsWith(CARD),
    JSON.stringify(home));
  ok('comments: …with Markdown flattened to text in the snippet', home.cards.some((c) => /Is Technology net of returns/.test(c.snippet)), JSON.stringify(home.cards));
  await win.click('#home-comments .cmt-home-card');
  await win.waitForTimeout(3500);
  const opened = await win.evaluate(() => {
    const p = document.querySelector('aside.ws-side[data-kind="comments"]') as HTMLElement | null;
    return { target: p?.dataset.target || '', focus: (p?.querySelector('.cmt-thread.is-focus .cmt-body')?.textContent || '').trim() };
  });
  ok('comments: a Home row opens the dashboard and that card\'s thread, focused',
    opened.target === 'card:' + b0.id && /bar looks high/.test(opened.focus), JSON.stringify(opened));

  // ── the other page heads: the builder (with ⌘-click) and the dataset page ──
  const visualId = await s.app.evaluate(async (_e, pid: string) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const v = (await req('./src/analysis/visuals.js').listVisuals(pid)).find((x: any) => x.name === 'Revenue by category');
    return v ? v.id : '';
  }, ids.projectId);
  await win.evaluate(async (id: string) => {
    const w = window as any;
    w.spClose();
    await w.handleBackToList();
    w.selectSection('visuals');
    await w.openSavedVisual(id);
  }, visualId);
  await win.waitForTimeout(3000);
  const vizBtn = await win.evaluate(() => {
    const b = document.getElementById('viz-comments-btn') as HTMLElement | null;
    return { shown: !!b && !b.hidden && b.getClientRects().length > 0, label: b?.getAttribute('aria-label') || '' };
  });
  ok('comments: the Visual builder head has a Comments button', vizBtn.shown && vizBtn.label === 'Comments (0)', JSON.stringify(vizBtn));
  const vbar = await win.evaluate(() => {
    const area = document.getElementById('viz-area');
    const chart = area ? chartInstances.get(area) : null;
    const el = chart && chart.getDatasetMeta(0).data[1];
    if (!el) return null;
    const c = el.getCenterPoint();
    return { x: Math.round(c.x), y: Math.round(c.y), label: String(chart.data.labels[1]) };
  });
  if (vbar) {
    await win.click('#viz-area canvas', { position: { x: vbar.x, y: vbar.y }, modifiers: ['Meta'] });
    await win.waitForTimeout(600);
  }
  const vpanel = await win.evaluate(() => ({
    target: (document.querySelector('aside.ws-side[data-kind="comments"]') as HTMLElement | null)?.dataset.target || '',
    pin: (document.querySelector('aside[data-kind="comments"] .cmt-compose-pin strong')?.textContent || '').trim(),
  }));
  ok('comments: ⌘-click a mark in the builder pins a comment to the visual',
    !!vbar && vpanel.target === 'visual:' + visualId && vpanel.pin === vbar.label, JSON.stringify({ vbar, vpanel }));

  await win.evaluate(async (id: string) => {
    const w = window as any;
    w.spClose();
    w.selectSection('datasets');
    await w.openSavedDataset(id);
  }, ids.datasetId);
  await win.waitForTimeout(2000);
  await win.click('#ds-comments-btn');
  await win.waitForTimeout(500);
  const dsPanel = await panel(win);
  ok('comments: the dataset page\'s Comments button opens that dataset\'s thread',
    dsPanel.target === 'dataset:' + ids.datasetId && /No comments yet/.test(dsPanel.empty), JSON.stringify(dsPanel));

  // Reports: the opt-in lives in the builder's settings, off by default.
  const opt = await win.evaluate(() => {
    const cb = document.getElementById('rp-set-discussion') as HTMLInputElement | null;
    return cb ? { present: true, checked: cb.checked } : { present: false, checked: false };
  });
  ok('comments: reports offer "Include discussion", unticked by default', opt.present && !opt.checked, JSON.stringify(opt));
  // …and a Discussion page resolves to the dashboard's threads, open first, which
  // all three writers print (they share reportPageBlocks — no writer of its own).
  const report = await win.evaluate(async (a: { projectId: string; dashboardId: string }) => {
    const w = window as any;
    const analysis = await w.hub.getAnalysis(a.projectId, a.dashboardId);
    const out: any = { sizes: {} };
    for (const format of ['pdf', 'pptx', 'docx']) {
      const rec = { name: 'Discussion check', format, cover: { title: 'x' }, paper: { size: 'letter', orientation: 'portrait' },
        pages: [{ id: 'p1', kind: 'discussion', include: true, layout: 'full' }] };
      const pages = await w.buildReportPages({ projectId: a.projectId, analysis, filters: [], report: rec });
      out.page = pages[0];
      out.sizes[format] = ((await w.reportBytes(pages, rec)).base64 || '').length;
    }
    return out;
  }, ids);
  const bullets: string[] = (report.page && report.page.bullets) || [];
  ok('comments: the report\'s Discussion page lists the threads (open first) with their replies',
    report.page && report.page.title === 'Discussion' && report.page.meta[0] === '2 open · 1 resolved'
    && /^\[Open\]/.test(bullets[0] || '') && bullets.some((b) => /↳ .*netted out/.test(b)) && /^\[Resolved\]/.test(bullets[bullets.length - 1] || ''),
    JSON.stringify(report.page));
  ok('comments: …and it prints as PDF, PPTX and DOCX', report.sizes.pdf > 1000 && report.sizes.pptx > 1000 && report.sizes.docx > 1000, JSON.stringify(report.sizes));
  await win.evaluate(() => { (window as any).spClose(); });
}
