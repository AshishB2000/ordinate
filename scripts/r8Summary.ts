// Round-8 smoke SECTION: the Summary card, driven through the REAL UI. Not a
// standalone smoke — scripts/smoke-round8.ts calls summarySection(s, fx) on its
// one launch.
//
//   The template gallery, on the bundled sample's Retail orders → a template →
//   Create dashboard: the new dashboard opens with a Summary card across the
//   top and every tile below it → its sentences are main's own, three to five,
//   ranked, with a timestamp, and (no model in a smoke) "Rewrite needs a model"
//   in place of the button → click a sentence: its tile scrolls into view and
//   pulses → a typed filter ("West") recomputes it, to main's filtered answer →
//   clear the selection → the card is removable, and More → Summary puts it
//   back on top → the dashboard export carries it as the first block, and a
//   report's first lines are its sentences. The dashboard it made is deleted;
//   the sample dashboard is never touched. Leaves the Dashboards list on screen.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject } from './smokeFixture';

const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Page-level globals (dashboards.ts / dashSelection.ts), read by bare name inside evaluate.
declare const dashCurrent: any;
declare let dashSaveTimer: number | null;

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<boolean> {
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

/** The card's sentences as drawn ('' while loading). */
const drawn = (win: Win): Promise<string[]> => win.evaluate(() =>
  [...document.querySelectorAll('.dash-card .sum-card .sum-item .sum-text')].map((e) => (e.textContent || '').trim()));

export async function summarySection(s: Smoke, _fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errors0 = s.errors.length;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(400);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };
  const ids: { projectId: string; datasetId: string; analysisId: string } | null = await app.evaluate(() => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return req('./src/app/config.js').get().sample || null;
  });
  ok('summary: the bundled sample is there to build from', !!ids && !!ids.projectId && !!ids.datasetId);
  if (!ids) return;
  const pid = ids.projectId;
  /** Main's own answer for the renderer's live sheets and filters. */
  const mainSays = (outbound = false): Promise<Array<{ text: string; cardId: string | null; magnitude: number }>> => win.evaluate(() => ({
    pages: dashCurrent.pages, filters: (window as any).effectiveFilters(), params: (window as any).dashParamPayload(), id: dashCurrent.id,
  })).then((live) => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const dashboards = req('./src/analysis/dashboards.js');
    const params = req('./src/analysis/params.js');
    const list = await req('./src/ipc/summary.js').computeSummary(a.pid, a.live.pages, {
      analysisId: a.live.id, filters: dashboards.sanitizeDashboardFilters(a.live.filters), params: params.paramValues(a.live.params), outbound: a.outbound,
    });
    return list.map((x: any) => ({ text: x.text, cardId: x.cardId, magnitude: x.magnitude }));
  }, { pid, live, outbound }));

  // ── The gallery: a template on Retail orders ─────────────────────────────
  await openProject(win, pid);
  await win.evaluate(() => { (window as any).selectSection('analyses'); });
  await win.waitForTimeout(800);
  await win.evaluate((d: string) => { void (window as any).anCreateWizard(d, { step: 2 }); }, ids.datasetId);
  ok('summary: the gallery offers a template for the sample',
    await until(win, () => win.evaluate(() => [...document.querySelectorAll('.an-wiz-tpl')].some((b) => !(b as HTMLButtonElement).disabled && !b.classList.contains('is-dim')))));
  const picked = await win.evaluate(() => {
    const b = [...document.querySelectorAll('.an-wiz-tpl')].find((x) => !(x as HTMLButtonElement).disabled && !x.classList.contains('is-dim')) as HTMLElement | undefined;
    if (!b) return '';
    b.click();
    return (b.querySelector('.an-wiz-tpl-t')?.textContent || '').trim();
  });
  ok(`summary: picked the "${picked}" template`, !!picked);
  ok('summary: Next to the mapping', await click(win, '.an-wiz-foot .btn-primary'));
  ok('summary: the mapping is ready to create', await until(win, () => win.evaluate(() => {
    const b = document.querySelector('.an-wiz-foot .btn-primary') as HTMLButtonElement | null;
    return !!b && b.textContent === 'Create dashboard' && !b.disabled;
  })));
  await win.waitForTimeout(1500); // the mapping's plan preview settles
  ok('summary: Create dashboard', await click(win, '.an-wiz-foot .btn-primary'));
  ok('summary: the new dashboard opens', await until(win, () => win.evaluate(() => !document.querySelector('.an-wiz') && !!dashCurrent && !!dashCurrent.id)));
  const aid: string = await win.evaluate(() => String(dashCurrent.id));

  try {
    // ── On top, full width, everything else below ──
    const top = await win.evaluate(() => {
      const cards = dashCurrent.pages[0].cards;
      const sum = cards[0];
      const el = sum && document.querySelector('.dash-card[data-card-id="' + sum.id + '"]') as HTMLElement | null;
      return {
        type: sum && sum.type, layout: sum && JSON.stringify(sum.layout),
        title: el ? (el.querySelector('.dash-card-title')?.textContent || '').trim() : '',
        col: el ? el.style.gridColumn : '', row: el ? el.style.gridRow : '',
        below: cards.slice(1).filter((c: any) => c.type !== 'control').every((c: any) => c.layout.y >= 4),
        others: cards.length - 1,
      };
    });
    ok('summary: the gallery put a Summary card first', top.type === 'summary' && top.layout === JSON.stringify({ x: 0, y: 0, w: 12, h: 4 }), JSON.stringify(top));
    ok('summary: drawn across the top, titled Summary', top.title === 'Summary' && top.col === '1 / span 12' && top.row === '1 / span 4', JSON.stringify(top));
    ok('summary: every template tile sits below it', top.below && top.others > 0, JSON.stringify(top));

    // ── Main's sentences, ranked, stamped ──
    ok('summary: the sentences render', await until(win, async () => (await drawn(win)).length > 0, 45_000));
    const want = await mainSays();
    const got = await drawn(win);
    ok(`summary: three to five sentences (${got.length})`, got.length >= 3 && got.length <= 5, got.join(' | '));
    ok('summary: exactly main\'s sentences, in main\'s order', JSON.stringify(got) === JSON.stringify(want.map((x) => x.text)), `${got.join(' | ')}\n vs ${want.map((x) => x.text).join(' | ')}`);
    ok('summary: ranked by magnitude', want.every((x, i) => i === 0 || want[i - 1].magnitude >= x.magnitude));
    ok('summary: the headline KPI\'s movement is one of them', want.some((x) => / (rose|fell|held at) /.test(x.text)), got.join(' | '));
    const stamp = await win.evaluate(() => (document.querySelector('.sum-stamp')?.textContent || '').trim());
    ok('summary: it shows when it was computed', /^Updated \d{1,2}:\d{2}/.test(stamp), stamp);
    const rw = await win.evaluate(() => ({
      button: !!document.querySelector('.sum-rewrite'),
      note: (document.querySelector('.sum-note')?.textContent || '').trim(),
      why: document.querySelector('.sum-note')?.getAttribute('title') || '',
    }));
    ok('summary: no model → no Rewrite button, and the reason instead', !rw.button && rw.note === 'Rewrite needs a model' && /model/i.test(rw.why), JSON.stringify(rw));
    await shot('summary-card.png');

    // ── A sentence links to its tile ──
    const link = want.findIndex((x) => !!x.cardId);
    ok('summary: a sentence links to a tile', link >= 0);
    if (link >= 0) {
      const target = want[link].cardId as string;
      await win.evaluate((i: number) => (document.querySelectorAll('.sum-card .sum-item .sum-text')[i] as HTMLElement).click(), link);
      const hit = await until(win, () => win.evaluate((id: string) => {
        const el = document.querySelector('.dash-card[data-card-id="' + id + '"]') as HTMLElement | null;
        if (!el || !el.classList.contains('sum-pulse')) return false;
        const r = el.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight;
      }, target), 5000);
      ok('summary: clicking it scrolls to that tile and pulses it', hit);
      await shot('summary-pulse.png');
    }

    // ── A typed filter recomputes it ──
    const applied = await win.evaluate(async () => {
      const res = await (window as any).ftParse('West', {});
      return res && res.ok ? (window as any).ftApplyChips(res.chips) : [];
    });
    ok('summary: a typed filter applies ("West")', applied.length > 0, JSON.stringify(applied));
    ok('summary: the card recomputes under it', await until(win, async () => {
      const now = await drawn(win);
      return now.length > 0 && JSON.stringify(now) !== JSON.stringify(got);
    }, 45_000));
    const wantWest = await mainSays();
    ok('summary: …to main\'s filtered answer', JSON.stringify(await drawn(win)) === JSON.stringify(wantWest.map((x) => x.text)),
      `${(await drawn(win)).join(' | ')}\n vs ${wantWest.map((x) => x.text).join(' | ')}`);
    ok('summary: the filter chip\'s × removes it', await win.evaluate(() => {
      const xs = [...document.querySelectorAll('.dash-sel-chip .dash-filter-chip-x')] as HTMLElement[];
      xs.forEach((x) => x.click());
      return xs.length > 0;
    }));
    ok('summary: clearing the filter brings the unfiltered sentences back',
      await until(win, async () => JSON.stringify(await drawn(win)) === JSON.stringify(got), 45_000));

    // ── Removable, and back from More → Summary ──
    await win.evaluate(() => (window as any).removeCard(dashCurrent.pages[0].cards[0]));
    ok('summary: the card can be removed', await win.evaluate(() => !document.querySelector('.sum-card') && dashCurrent.pages[0].cards.every((c: any) => c.type !== 'summary')));
    ok('summary: More opens the add menu', await click(win, '#dash-add-more'));
    const added = await win.evaluate(() => {
      const row = [...document.querySelectorAll('.chart-menu-item')].find((b) => (b.textContent || '').trim() === 'Summary') as HTMLElement | undefined;
      if (!row) return false;
      row.click();
      return true;
    });
    ok('summary: More → Summary', added);
    ok('summary: it is back on top', await win.evaluate(() => {
      const c = dashCurrent.pages[0].cards;
      return c[0].type === 'summary' && c[0].layout.y === 0 && c.slice(1).filter((x: any) => x.type !== 'control').every((x: any) => x.layout.y >= 4);
    }));
    ok('summary: and draws again', await until(win, async () => JSON.stringify(await drawn(win)) === JSON.stringify(got), 45_000));

    // ── Exports: the first block ──
    const outbound = (await mainSays(true)).map((x) => x.text);
    const bundle = await win.evaluate(async () => {
      const b = await (window as any).assembleExportBundle(false);
      const first = b.pages[0].cards[0];
      return { kind: first.kind, heading: first.heading, text: first.text };
    });
    ok('summary: the dashboard export leads with it as a text block',
      bundle.kind === 'text' && bundle.heading === 'Summary' && bundle.text === outbound.join('\n\n'), JSON.stringify(bundle));
    const report = await win.evaluate(async () => (window as any).sumReportLines({
      projectId: (window as any).currentProjectId, analysis: { id: dashCurrent.id, name: dashCurrent.name, sheets: dashCurrent.pages }, filters: [], params: [],
    }));
    ok('summary: a report\'s first lines are its sentences', JSON.stringify(report) === JSON.stringify(outbound), JSON.stringify(report));
  } finally {
    // ── Leave no trace: the dashboard this section made goes ──
    await win.evaluate(() => { if (dashSaveTimer) clearTimeout(dashSaveTimer); dashSaveTimer = null; });
    await win.evaluate(() => { (window as any).selectSection('datasets'); });
    await win.waitForTimeout(500);
    await app.evaluate(async (_e, a: any) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      await req('./src/analysis/analysis.js').deleteAnalysis(a.pid, a.aid);
    }, { pid, aid });
    await win.evaluate(() => { (window as any).selectSection('analyses'); });
    await win.evaluate(() => (window as any).refreshAnalysisList?.());
    await win.waitForTimeout(500);
  }
  const gone = await app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    return !(await req('./src/analysis/analysis.js').getAnalysis(a.pid, a.aid));
  }, { pid, aid });
  ok('summary: the dashboard it made is deleted', gone);
  ok('summary: no renderer errors in this section', s.errors.length === errors0, s.errors.slice(errors0).join('\n'));
}
