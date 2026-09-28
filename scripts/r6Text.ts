// Round-6 smoke SECTION: text analytics, driven through the REAL UI. Not a
// standalone smoke — scripts/smoke-round6.ts calls textSection(s, fx) on its one
// launch and fixture.
//
//   A "Customer reviews" dataset (seeded here: short reviews across three
//   regions) → the review column's profile grows a Text section with top terms
//   and a sentiment spread → its "Add sentiment" opens the Prepare step
//   prefilled → Save → a number column whose values for two known sentences
//   are what main's VADER module returns → "Tag with rules" from the Add step
//   menu, two rules typed in → the category column → "Count terms" by region,
//   ranked by TF-IDF → West's most distinctive term is "parking" (the fixture
//   puts it in West's reviews and nowhere else) → a word cloud built over the
//   terms table in the Visuals builder draws words on its canvas, and saves.
// Leaves the app on the project's Data list with nothing open.

import { ok } from './selfcheck';
import type { Smoke, Fixture } from './smokeFixture';
import { openProject, domDriver } from './smokeFixture';

const path: typeof import('path') = require('path');

type Win = Smoke['win'];
// Page-level `const`s read by bare name inside evaluate — not on window.
declare const chartInstances: any;

const S_POS = 'The staff were friendly and helpful; would recommend.';
const S_NEG = 'Refund took three weeks, terrible customer support.';

async function until(win: Win, fn: () => boolean | Promise<boolean>, ms = 20_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await win.waitForTimeout(200);
  }
  return false;
}

const text = (win: Win, sel: string): Promise<string> =>
  win.evaluate((q: string) => (document.querySelector(q)?.textContent || '').trim(), sel);

const click = (win: Win, sel: string): Promise<boolean> =>
  win.evaluate((q: string) => {
    const el = document.querySelector(q) as HTMLElement | null;
    if (!el || el.getClientRects().length === 0 || (el as HTMLButtonElement).disabled) return false;
    el.click();
    return true;
  }, sel);

/** Click a visible button inside `scope` by its exact text. */
const clickText = (win: Win, scope: string, label: string): Promise<boolean> =>
  win.evaluate((a: { s: string; t: string }) => {
    const el = [...document.querySelectorAll(a.s + ' button')]
      .find((b) => (b as HTMLElement).getClientRects().length > 0 && (b.textContent || '').trim() === a.t) as HTMLElement | undefined;
    if (!el) return false;
    el.click();
    return true;
  }, { s: scope, t: label });

/** Set a form control's value and fire what a user's edit fires. */
const setField = (win: Win, sel: string, value: string, nth = 0): Promise<boolean> =>
  win.evaluate((a: { q: string; v: string; n: number }) => {
    const el = document.querySelectorAll(a.q)[a.n] as HTMLInputElement | HTMLSelectElement | undefined;
    if (!el) return false;
    el.value = a.v;
    if (el.value !== a.v) return false;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { q: sel, v: value, n: nth });

function reviews(): Array<[string, string, number]> {
  const west = [
    'Parking was a nightmare but the staff were lovely',
    'Great coffee, terrible parking, friendly barista',
    'The parking lot is tiny and always full on weekends',
    'Easy to find, but parking costs more than the meal',
    'Lovely terrace, great service, awful parking situation',
    'Parking attendant was rude, food was great though',
  ];
  const east = [
    'Delivery was late again and the box was damaged',
    'Great value, the delivery driver was very polite',
    'Delivery took two weeks, the packaging was great though',
    'Fast delivery and great service, will order again',
    S_POS,
    'The delivery tracking never updated, great product otherwise',
  ];
  const north = [
    S_NEG,
    'Asked for a refund twice before anyone answered',
    'Great product but the refund process is painfully slow',
    'Service was great, refund policy is confusing',
    'Still waiting for my refund after a month of emails',
    'Helpful staff sorted my refund in one great phone call',
  ];
  const out: Array<[string, string, number]> = [];
  for (let i = 0; i < 6; i += 1) {
    out.push(['West', west[i], 3 + (i % 3)], ['East', east[i], 2 + (i % 4)], ['North', north[i], 1 + (i % 5)]);
  }
  return out;
}

export async function textSection(s: Smoke, fx: Fixture): Promise<void> {
  const { app, win } = s;
  const errors0 = s.errors.length;
  const pid = fx.projectId;
  const shot = async (name: string): Promise<void> => {
    await win.waitForTimeout(300);
    await win.screenshot({ path: path.join(s.shotDir, name) }).catch(() => null);
  };

  // ── Seed, and ask main's own VADER for the two known sentences ────────────
  const seeded: { id: string; pos: number; neg: number } = await app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const datasets = req('./src/data/datasets.js');
    const vader = req('./src/analysis/text/vader.js');
    const ds = await datasets.saveDataset(a.pid, {
      name: 'Customer reviews',
      sourceKind: 'csv',
      columns: [{ name: 'region', type: 'text' }, { name: 'review', type: 'text' }, { name: 'stars', type: 'number' }],
      rows: a.rows,
    });
    return { id: ds.id, pos: vader.compoundScore(a.pos), neg: vader.compoundScore(a.neg) };
  }, { pid, rows: reviews(), pos: S_POS, neg: S_NEG });
  const id = seeded.id;
  ok('text: the reviews dataset is seeded', !!id);
  const mainRows = (): Promise<{ columns: string[]; rows: any[][] }> => app.evaluate(async (_e, a: any) => {
    const req = (process as any).mainModule.require.bind((process as any).mainModule);
    const ds = await req('./src/data/datasets.js').getDataset(a.pid, a.id);
    return { columns: ds.columns.map((c: any) => c.name), rows: ds.rows };
  }, { pid, id });

  // ── The profile's Text section ─────────────────────────────────────────────
  await openProject(win, pid);
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(800);
  await win.evaluate((d: string) => (window as any).openSavedDataset(d), id);
  await until(win, () => win.evaluate(() => document.querySelectorAll('#ds-explorer-scroll .ds-th-name').length >= 3));
  ok('text: the review header opens its profile', await win.evaluate(() => {
    const b = [...document.querySelectorAll('#ds-explorer-scroll .ds-th-name')]
      .find((x) => (x.textContent || '').trim() === 'review') as HTMLElement | undefined;
    if (!b) return false;
    b.click();
    return true;
  }));
  const shown = await until(win, () => win.evaluate(() => {
    const sec = document.querySelector('#ds-profile .tx-dsp') as HTMLElement | null;
    return !!sec && !sec.hidden && sec.querySelectorAll('.tx-term-row').length > 0;
  }));
  ok('text: the profile shows a Text section for reviews (average ≥ 20 characters)', shown, await text(win, '#ds-profile'));
  const terms: string[] = await win.evaluate(() => [...document.querySelectorAll('#ds-profile .tx-dsp .tx-term-row .dsp-bar-label')]
    .map((l) => (l.textContent || '').trim()));
  ok('text: top terms lead with the word every region uses ("great"), stop words gone',
    terms[0] === 'great' && !terms.includes('the') && terms.includes('parking'), JSON.stringify(terms));
  ok('text: the section states its sample and carries a sentiment spread',
    /All 18 filled values/.test(await text(win, '#ds-profile .tx-dsp')) && await win.evaluate(() =>
      document.querySelectorAll('#ds-profile .tx-dsp .tx-senti-seg').length > 0), await text(win, '#ds-profile .tx-dsp'));
  ok('text: the Text section leads the value distribution', await win.evaluate(() => {
    const sec = document.querySelector('#ds-profile .tx-dsp');
    const chart = document.querySelector('#ds-profile .js-dsp-chart');
    return !!sec && !!chart && !!(sec.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_FOLLOWING);
  }));
  await shot('text-profile.png');
  await win.evaluate(() => { document.querySelector('#ds-profile .tx-dsp-actions')?.scrollIntoView({ block: 'end' }); });
  await shot('text-profile-end.png');

  // A short-label column has no Text section.
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('#ds-explorer-scroll .ds-th-name')]
      .find((x) => (x.textContent || '').trim() === 'region') as HTMLElement | undefined;
    b?.click();
  });
  await win.waitForTimeout(1200);
  ok('text: a short-label text column (region) shows no Text section', await win.evaluate(() => {
    const sec = document.querySelector('#ds-profile .tx-dsp') as HTMLElement | null;
    return !sec || !!sec.hidden;
  }));
  await win.evaluate(() => {
    const b = [...document.querySelectorAll('#ds-explorer-scroll .ds-th-name')]
      .find((x) => (x.textContent || '').trim() === 'review') as HTMLElement | undefined;
    b?.click();
  });
  await until(win, () => win.evaluate(() => {
    const sec = document.querySelector('#ds-profile .tx-dsp') as HTMLElement | null;
    return !!sec && !sec.hidden && sec.querySelectorAll('.tx-dsp-actions button').length === 3;
  }));

  // ── Add sentiment, from the profile ────────────────────────────────────────
  ok('text: "Add sentiment" opens the step prefilled', await clickText(win, '#ds-profile .tx-dsp-actions', 'Add sentiment'));
  await until(win, async () => /rows scored/.test(await text(win, '#ds-step-editor .pp-preview')));
  ok('text: the sentiment editor previews main\'s scores', /18 rows scored/.test(await text(win, '#ds-step-editor .pp-preview')),
    await text(win, '#ds-step-editor'));
  ok('text: …on the review column', await win.evaluate(() =>
    (document.querySelector('#ds-step-editor select') as HTMLSelectElement | null)?.value === 'review'));
  await win.evaluate(() => { document.querySelector('#ds-step-editor .pp-preview')?.scrollIntoView({ block: 'center' }); });
  await shot('text-sentiment-editor.png');
  ok('text: Save step', await clickText(win, '#ds-step-editor', 'Save step'));
  ok('text: the dataset gains review_sentiment', await until(win, async () => (await mainRows()).columns.includes('review_sentiment')));
  {
    const d = await mainRows();
    const ti = d.columns.indexOf('review');
    const si = d.columns.indexOf('review_sentiment');
    const pos = d.rows.find((r) => r[ti] === S_POS);
    const neg = d.rows.find((r) => r[ti] === S_NEG);
    ok('text: the positive sentence scores exactly what main\'s VADER returns', !!pos && Object.is(pos[si], seeded.pos),
      JSON.stringify({ got: pos && pos[si], want: seeded.pos }));
    ok('text: the negative sentence scores exactly what main\'s VADER returns', !!neg && Object.is(neg[si], seeded.neg),
      JSON.stringify({ got: neg && neg[si], want: seeded.neg }));
    ok('text: the scores are VADER\'s published signs (+0.8176, −0.1027)', seeded.pos === 0.8176 && seeded.neg === -0.1027);
  }
  ok('text: the grid shows the new column', await until(win, () => win.evaluate(() =>
    [...document.querySelectorAll('#ds-explorer-scroll .ds-th-name')].some((b) => (b.textContent || '').trim() === 'review_sentiment'))));
  ok('text: the step list names the step and its lexicon', /Sentiment of review.*vaderSentiment 3\.3\.2/.test(await text(win, '#ds-steps-list')),
    await text(win, '#ds-steps-list'));

  // ── Tag with rules, from the Add step menu ─────────────────────────────────
  ok('text: Add step opens the menu', await click(win, '#ds-step-add'));
  await win.waitForTimeout(300);
  ok('text: the menu offers "Text — tag with keyword rules"', await win.evaluate(() => {
    const b = [...document.querySelectorAll('.chart-menu-item')].find((x) => (x.textContent || '').trim() === 'Text — tag with keyword rules') as HTMLElement | undefined;
    if (!b) return false;
    b.click();
    return true;
  }));
  await until(win, () => win.evaluate(() => document.querySelectorAll('#ds-step-editor .tx-rule').length === 1));
  await setField(win, '#ds-step-editor select', 'review');
  await setField(win, '#ds-step-editor .tx-pat', 'parking');
  await setField(win, '#ds-step-editor .tx-cat', 'Parking');
  ok('text: + Add rule adds a second row', await clickText(win, '#ds-step-editor', '+ Add rule')
    && await until(win, () => win.evaluate(() => document.querySelectorAll('#ds-step-editor .tx-rule').length === 2)));
  await setField(win, '#ds-step-editor .tx-pat', 'refund', 1);
  await setField(win, '#ds-step-editor .tx-cat', 'Billing', 1);
  await until(win, async () => /Parking/.test(await text(win, '#ds-step-editor .pp-preview')));
  ok('text: the preview counts rows per category (6 Parking, 6 Billing, 6 Other)', await until(win, () => win.evaluate(() => {
    const rows = [...document.querySelectorAll('#ds-step-editor .pp-preview .dsp-bar-row')].map((r) => (r.textContent || '').replace(/\s+/g, ' '));
    return rows.length === 3 && /^Parking6/.test(rows[0].replace(/ /g, '')) && /^Billing6/.test(rows[1].replace(/ /g, ''));
  })), await text(win, '#ds-step-editor .pp-preview'));
  await win.evaluate(() => { document.querySelector('#ds-step-editor .tx-rules')?.scrollIntoView({ block: 'center' }); });
  await shot('text-rules-editor.png');
  ok('text: Save step (rules)', await clickText(win, '#ds-step-editor', 'Save step'));
  ok('text: the dataset gains review_category', await until(win, async () => (await mainRows()).columns.includes('review_category')));
  {
    const d = await mainRows();
    const ri = d.columns.indexOf('region');
    const ci = d.columns.indexOf('review_category');
    const byRegion = (reg: string) => [...new Set(d.rows.filter((r) => r[ri] === reg).map((r) => r[ci]))];
    ok('text: West is tagged Parking, North Billing, East falls to Other',
      JSON.stringify(byRegion('West')) === '["Parking"]' && JSON.stringify(byRegion('North')) === '["Billing"]'
      && JSON.stringify(byRegion('East')) === '["Other"]', JSON.stringify([byRegion('West'), byRegion('North'), byRegion('East')]));
  }

  // ── Count terms by region, ranked by TF-IDF ────────────────────────────────
  ok('text: Add step → "Text — count terms"', await click(win, '#ds-step-add') && await win.evaluate(() => {
    const b = [...document.querySelectorAll('.chart-menu-item')].find((x) => (x.textContent || '').trim() === 'Text — count terms') as HTMLElement | undefined;
    if (!b) return false;
    b.click();
    return true;
  }));
  await until(win, () => win.evaluate(() => document.querySelectorAll('#ds-step-editor select').length >= 4));
  // Selects in order: text column, language, terms, group by, rank.
  await setField(win, '#ds-step-editor select', 'review', 0);
  await setField(win, '#ds-step-editor select', '1-1', 2);
  ok('text: group by region', await setField(win, '#ds-step-editor select', 'region', 3));
  ok('text: rank by TF-IDF', await setField(win, '#ds-step-editor select', 'tfidf', 4));
  await until(win, async () => /tfidf/.test(await text(win, '#ds-step-editor .pp-preview')));
  ok('text: the preview shows the terms table with tfidf', /region.*term.*words.*count.*tfidf/.test(await text(win, '#ds-step-editor .pp-preview')),
    await text(win, '#ds-step-editor .pp-preview'));
  await shot('text-terms-editor.png');
  ok('text: Save step (terms)', await clickText(win, '#ds-step-editor', 'Save step'));
  ok('text: the dataset becomes region / term / words / count / tfidf', await until(win, async () =>
    JSON.stringify((await mainRows()).columns) === JSON.stringify(['region', 'term', 'words', 'count', 'tfidf'])));
  {
    const d = await mainRows();
    const west = d.rows.filter((r) => r[0] === 'West');
    ok('text: West\'s most distinctive term is "parking" (only West mentions it)', !!west[0] && west[0][1] === 'parking' && west[0][4] > 0,
      JSON.stringify(west.slice(0, 3)));
    const great = d.rows.find((r) => r[0] === 'West' && r[1] === 'great');
    ok('text: a word every region uses ("great") scores exactly 0', !!great && Object.is(great[4], 0), JSON.stringify(great));
  }
  ok('text: the grid shows the terms table', await until(win, () => win.evaluate(() =>
    [...document.querySelectorAll('#ds-explorer-scroll .ds-th-name')].some((b) => (b.textContent || '').trim() === 'tfidf'))));

  // ── A word cloud over the terms, built in the Visuals builder ──────────────
  const { clickId, fillPrompt } = domDriver(win);
  await win.evaluate(() => { (window as any).selectSection('visuals'); });
  await win.waitForTimeout(900);
  ok('text: Visuals → New', await clickId('viz-new-btn'));
  await win.waitForTimeout(900);
  ok('text: the builder opens on Customer reviews', await win.evaluate(() => {
    const row = [...document.querySelectorAll('.vn-row')].find((x) => /Customer reviews/.test(x.textContent || '')) as HTMLElement | undefined;
    if (!row) return false;
    row.click();
    const manual = document.querySelector('.js-vn-manual') as HTMLElement | null;
    if (!manual) return false;
    manual.click();
    return true;
  }));
  await until(win, () => win.evaluate(() => !(document.getElementById('viz-builder') as HTMLElement).hidden));
  const encoded = await win.evaluate(async () => {
    const box = document.getElementById('ws-visuals') as HTMLElement;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const cat = box.querySelector('.js-enc-cat') as HTMLSelectElement | null;
    if (!cat) return false;
    cat.value = 'term';
    cat.dispatchEvent(new Event('change', { bubbles: true }));
    await pause(600);
    const sel = box.querySelector('.viz-value-col') as HTMLSelectElement | null;
    if (!sel) return false;
    sel.value = 'count';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await pause(400);
    return cat.value === 'term' && sel.value === 'count';
  });
  ok('text: encoding — term by count', encoded);
  await win.waitForTimeout(1500);
  const picked = await win.evaluate(() => {
    const chip = [...document.querySelectorAll('#viz-switcher-mount .cv-viz-chip')]
      .find((b) => (b.textContent || '').trim() === 'Word cloud') as HTMLElement | undefined;
    if (chip) { chip.click(); return true; }
    const more = [...document.querySelectorAll('#viz-switcher-mount button')].find((b) => /More/i.test(b.textContent || '')) as HTMLElement | undefined;
    if (more) more.click();
    return false;
  }) || (await win.waitForTimeout(500), await win.evaluate(() => {
    const tile = [...document.querySelectorAll('.cv-more-panel .cv-more-item')]
      .find((b) => (b.textContent || '').trim().startsWith('Word cloud')) as HTMLElement | undefined;
    if (!tile) return false;
    tile.click();
    return true;
  }));
  ok('text: the chart picker offers Word cloud for a category and one measure', picked);
  const drawn = await until(win, () => win.evaluate(() => {
    const area = document.getElementById('viz-area') as HTMLElement | null;
    const inst = area ? chartInstances.get(area) : null;
    return !!inst && inst.config && inst.config.type === 'word_cloud' && !!inst.layout && inst.layout.placed.length > 0;
  }), 20_000);
  const cloud = await win.evaluate(() => {
    const area = document.getElementById('viz-area') as HTMLElement;
    const inst = chartInstances.get(area);
    const canvas = area.querySelector('canvas') as HTMLCanvasElement | null;
    // Real ink: some pixel of the canvas is not transparent.
    let inked = false;
    if (canvas && canvas.width) {
      const px = (canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 3; i < px.length; i += 4 * 7) if (px[i] > 0) { inked = true; break; }
    }
    return {
      w: canvas ? canvas.width : 0, h: canvas ? canvas.height : 0, inked,
      words: inst && inst.layout ? inst.layout.placed.map((p: any) => p.text) : [],
      label: canvas ? canvas.getAttribute('aria-label') : '',
    };
  });
  ok('text: the word cloud draws words on a real canvas', drawn && cloud.w > 0 && cloud.h > 0 && cloud.inked && cloud.words.length >= 10,
    JSON.stringify({ ...cloud, words: cloud.words.slice(0, 8) }));
  ok('text: the biggest word is placed first and named for screen readers', cloud.words[0] === 'great' && /^Word cloud: great/.test(cloud.label || ''),
    JSON.stringify({ first: cloud.words[0], label: cloud.label }));
  await shot('text-word-cloud.png');
  ok('text: the word cloud saves', await clickId('viz-save-btn') && (await win.waitForTimeout(600), await fillPrompt('Review words')));
  ok('text: …and lands in the gallery', await until(win, () => win.evaluate(() =>
    [...document.querySelectorAll('.viz-card')].some((c) => (c.textContent || '').includes('Review words')))));
  await win.evaluate(() => { (window as any).selectSection('visuals'); });
  ok('text: its gallery card draws a live word-cloud thumbnail', await until(win, () => win.evaluate(() => {
    const card = [...document.querySelectorAll('.viz-card')].find((c) => (c.textContent || '').includes('Review words'));
    const canvas = card ? (card.querySelector('.viz-thumb canvas') as HTMLCanvasElement | null) : null;
    return !!canvas && canvas.width > 0 && canvas.height > 0;
  }), 20_000));
  const caption: string = await win.evaluate(async (a: { pid: string; id: string }) => {
    const hub = (window as any).hub;
    const list = await hub.listVisuals(a.pid);
    const row = list.find((v: any) => v.name === 'Review words');
    const v = row && await hub.getVisual(a.pid, row.id);
    if (!v) return '';
    const res = await hub.computeVisualData(a.pid, v.datasetId, v.encoding, v.filters || []);
    return hub.reportsCaption({ chartType: v.chartType, data: res.data, overrides: v.overrides });
  }, { pid, id });
  ok('text: the caption names the biggest word — never the folded "Other" tail',
    /^“[^”]+” is the biggest of \d+ words, count \d/.test(caption) && !/^“Other”/.test(caption), caption);
  await shot('text-gallery.png');

  // ── Neutral: back on the project's Data list, nothing open ─────────────────
  await win.evaluate(() => { (window as any).selectSection('datasets'); });
  await win.waitForTimeout(800);
  await win.evaluate(() => { (document.getElementById('ds-explorer-close') as HTMLElement | null)?.click(); });
  await win.waitForTimeout(400);
  ok('text: back on the dataset list', await win.evaluate(() => !!document.getElementById('ds-explorer')?.hidden));
  ok('text: no modal is left open', await win.evaluate(() =>
    ![...document.querySelectorAll('.ws-modal-overlay')].some((o) => (o as HTMLElement).getClientRects().length > 0)));
  const errors = s.errors.slice(errors0);
  ok('text: no renderer console errors in this section', errors.length === 0, JSON.stringify(errors.slice(0, 5)));
}
