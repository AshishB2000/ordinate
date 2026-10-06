// Self-check for layouts for every size (src/analysis/sizeLayout.ts — the ONE
// derivation the hub editor, the hub viewer and Publish all call).
//
//   1. THE BREAKPOINT CHOICE — phone below 600px of dashboard width, tablet
//      below 900, desktop from 900; present mode never below tablet; the
//      published page's media queries are the same numbers.
//   2. THE DERIVATION ON THE SAMPLE DASHBOARD — the real one, seeded the way a
//      first launch seeds it: reading order, KPI pairing on phone, KPIs four-up
//      and half-width charts paired on tablet, heights from the card KIND, and
//      a hidden card re-pairing what is left.
//   3. AN EDITED LAYOUT SURVIVING DESKTOP EDITS — a card added on desktop lands
//      at its derived position in the edited phone order, a removed one drops
//      out, hidden stays hidden, a height stays set — and the stored shape
//      survives main's whitelist and a save round trip.
//   4. PUBLISH carries every tile's tablet / phone cell through its whitelist.
//   5. REPORTS IGNORE `layouts` — a report is the desktop dashboard.
//
//   npm run build:ts && node scripts/test-sizeLayouts.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-sizes-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

// ponytail: sizeLayout.js is a UMD script, not a TS module (see test-cardLayout.ts)
const sl = require('../src/analysis/sizeLayout') as any;
const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const analysis: typeof import('../src/analysis/analysis') = require('../src/analysis/analysis');
const dashboards: typeof import('../src/analysis/dashboards') = require('../src/analysis/dashboards');
const reportSpec: typeof import('../src/analysis/reportSpec') = require('../src/analysis/reportSpec');
const { sanitizePage: sanitizePublished } = require('../src/publish/sanitize') as typeof import('../src/publish/sanitize');
const { sizeCss } = require('../src/publish/siteHtml') as typeof import('../src/publish/siteHtml');

const J = (v: unknown): string => JSON.stringify(v);
const ids = (items: any[]): string[] => items.map((i) => i.id);

async function main(): Promise<void> {
  // ── 1. The breakpoint choice ───────────────────────────────────────────────
  const picks = [0, 1, 599, 600, 899, 900, 1440].map((w) => sl.pickSize(w));
  ok('breakpoint: 0 (not laid out) desktop · 1 and 599 phone · 600 and 899 tablet · 900 and up desktop',
    J(picks) === J(['desktop', 'phone', 'phone', 'tablet', 'tablet', 'desktop', 'desktop']), J(picks));
  ok('breakpoint: the thresholds are the exported constants',
    sl.BREAKPOINTS.phone === 600 && sl.BREAKPOINTS.tablet === 900 && sl.pickSize(sl.BREAKPOINTS.phone - 1) === 'phone'
      && sl.pickSize(sl.BREAKPOINTS.tablet - 1) === 'tablet' && sl.pickSize(sl.BREAKPOINTS.tablet) === 'desktop');
  ok('breakpoint: present mode on a small window uses tablet, never phone',
    sl.presentSize(420) === 'tablet' && sl.presentSize(700) === 'tablet' && sl.presentSize(1200) === 'desktop');
  ok('breakpoint: the grid widths are 12 / 8 / 2', J(sl.COLS) === J({ desktop: 12, tablet: 8, phone: 2 }));
  const css = sizeCss();
  ok('breakpoint: the published page switches at the same dashboard widths (plus its 40px of padding)',
    css.includes('@media (max-width: 639px)') && css.includes('@media (min-width: 640px) and (max-width: 939px)'), css.slice(0, 400));
  ok('breakpoint: …with 8 tracks on tablet and 2 on phone, and per-size hiding',
    /repeat\(8, minmax\(0, 1fr\)\)/.test(css) && /repeat\(2, minmax\(0, 1fr\)\)/.test(css)
      && css.includes('.pub-hide-t { display: none; }') && css.includes('.pub-hide-p { display: none; }'));

  // ── 2. The derivation on the sample dashboard ──────────────────────────────
  await projects.init();
  const seeded = await sample.seedSampleProject();
  const pid = String(seeded.projectId);
  const aid = String(seeded.analysisId);
  const rec = await analysis.getAnalysis(pid, aid);
  ok('sample: seeded, one sheet', !!rec && rec.sheets.length === 1);
  if (!rec) return;
  const sheet = rec.sheets[0];
  const cards: any[] = sheet.cards;
  const reading = cards.filter((c) => c.type !== 'control').slice()
    .sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x).map((c) => c.id);
  const kpis = cards.filter((c) => c.type === 'metric').sort((a, b) => a.layout.x - b.layout.x);
  const charts = cards.filter((c) => c.type === 'visual');
  const map = charts.find((c) => c.layout.w === 12)!;
  const halves = charts.filter((c) => c.layout.w <= 6);
  const note = cards.find((c) => c.type === 'text')!;
  ok('sample: four KPIs, two half-width charts, a full-width map and a note',
    kpis.length === 4 && halves.length === 2 && !!map && !!note, J(cards.map((c) => [c.type, c.layout])));

  const phone = sl.resolve(cards, undefined, 'phone');
  ok('phone: derived, 2 tracks, every tile placed', !phone.edited && phone.cols === 2 && phone.items.length === cards.length && phone.hidden.length === 0);
  ok('phone: rows read top to bottom, left to right', J(ids(phone.items)) === J(reading), J(ids(phone.items)));
  const pk = phone.items.slice(0, 4);
  ok('phone: the four KPIs sit two-up — two rows of a pair',
    J(pk.map((i: any) => [i.x, i.y, i.w])) === J([[0, 0, 1], [1, 0, 1], [0, 2, 1], [1, 2, 1]]), J(pk));
  const pc = phone.items.filter((i: any) => charts.some((c) => c.id === i.id));
  ok('phone: every chart takes the full width at 6 rows, whatever its desktop size',
    pc.length === 3 && pc.every((i: any) => i.x === 0 && i.w === 2 && i.h === 6), J(pc));
  const pn = phone.items.find((i: any) => i.id === note.id);
  ok('phone: the note is full width, shorter than a chart, taller than two rows for its ~170 characters',
    pn.w === 2 && pn.h > 2 && pn.h < 6, J(pn));
  ok('phone: rows stack with no gaps', phone.items.every((i: any, n: number) => n < 2 || i.y >= phone.items[n - 1].y) && phone.rows === phone.items.reduce((m: number, i: any) => Math.max(m, i.y + i.h), 0));

  const tablet = sl.resolve(cards, undefined, 'tablet');
  const tk = tablet.items.slice(0, 4);
  ok('tablet: 8 tracks; the KPI strip stays one row, four-up at w=2',
    tablet.cols === 8 && J(tk.map((i: any) => [i.x, i.y, i.w, i.h])) === J([[0, 0, 2, 2], [2, 0, 2, 2], [4, 0, 2, 2], [6, 0, 2, 2]]), J(tk));
  const th = tablet.items.filter((i: any) => halves.some((c) => c.id === i.id));
  ok('tablet: the two half-width charts pair on one row at w=4',
    th.length === 2 && th[0].y === th[1].y && th[0].w === 4 && th[1].w === 4 && th[0].x === 0 && th[1].x === 4, J(th));
  const tm = tablet.items.find((i: any) => i.id === map.id);
  ok('tablet: the full-width map stays full width', tm.x === 0 && tm.w === 8 && tm.h === 6, J(tm));

  const tall = cards.map((c) => (c.id === halves[0].id ? { ...c, layout: { ...c.layout, h: 14 } } : c));
  ok('derivation: heights come from the card kind, not its desktop h',
    sl.resolve(tall, undefined, 'phone').items.find((i: any) => i.id === halves[0].id).h === 6);

  const hideOne = sl.materialize(cards, undefined);
  sl.setHidden(hideOne, kpis[1].id, true);
  const ph = sl.resolve(cards, hideOne, 'phone');
  ok('hidden: a KPI hidden on phone is not placed and is listed as hidden',
    ph.edited && !ids(ph.items).includes(kpis[1].id) && J(ph.hidden) === J([kpis[1].id]));
  ok('hidden: the three KPIs left re-pair — a pair, then the odd one out across the full row',
    J(ph.items.slice(0, 3).map((i: any) => [i.id, i.x, i.y, i.w])) === J([[kpis[0].id, 0, 0, 1], [kpis[2].id, 1, 0, 1], [kpis[3].id, 0, 2, 2]]),
    J(ph.items.slice(0, 3)));
  ok('hidden: the tablet layout is untouched by a phone edit', J(sl.resolve(cards, undefined, 'tablet')) === J(tablet));

  // ── 3. An edited phone layout surviving desktop edits ──────────────────────
  const edited = sl.materialize(cards, undefined);
  ok('edit: the first edit materialises the derived order', J(ids(edited.items)) === J(reading) && edited.items.every((i: any) => !i.hidden && i.h === undefined));
  ok('edit: move the map to the top', sl.moveItem(edited, map.id, kpis[0].id, false));
  ok('edit: hide the third KPI', sl.setHidden(edited, kpis[2].id, true));
  ok('edit: make the note 5 rows', sl.setHeight(edited, note.id, 5) && !sl.setHeight(edited, note.id, 5));
  ok('edit: heights clamp to 1..' + sl.MAX_H, (() => {
    const c = sl.materialize(cards, edited);
    sl.setHeight(c, note.id, 999);
    const hi = c.items.find((i: any) => i.id === note.id).h;
    sl.setHeight(c, note.id, -3);
    return hi === sl.MAX_H && c.items.find((i: any) => i.id === note.id).h === 1;
  })());
  const before = sl.resolve(cards, edited, 'phone');
  ok('edit: the map leads the phone layout, full width', before.items[0].id === map.id && before.items[0].w === 2, J(before.items[0]));
  ok('edit: the note keeps its 5 rows', before.items.find((i: any) => i.id === note.id).h === 5);

  const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const midKpi = { id: uuid(1), type: 'metric', layout: { x: 4, y: 0, w: 2, h: 2 }, metric: { datasetId: kpis[0].metric.datasetId, column: 'units', aggregation: 'sum', label: 'Extra' } };
  const endText = { id: uuid(2), type: 'text', heading: 'Footnote', layout: { x: 0, y: 900, w: 12, h: 1 } };
  const firstText = { id: uuid(3), type: 'text', heading: 'Title', layout: { x: 0, y: -1, w: 12, h: 1 } };
  const added = cards.concat([midKpi, endText]);
  const withAdds = sl.resolve(added, edited, 'phone');
  const order = ids(withAdds.items);
  ok('add on desktop: a card between KPI 2 and KPI 3 lands right after KPI 2 in the EDITED order',
    order.indexOf(midKpi.id) === order.indexOf(kpis[1].id) + 1 && order[0] === map.id, J(order));
  ok('add on desktop: a card at the bottom lands after the card before it in derived order', order[order.length - 1] === endText.id, J(order));
  ok('add on desktop: the new cards get derived sizes (KPI paired, text full width)',
    withAdds.items.find((i: any) => i.id === midKpi.id).w === 1 && withAdds.items.find((i: any) => i.id === endText.id).w === 2);
  ok('add on desktop: a card first in derived order leads the edited order',
    ids(sl.resolve([firstText].concat(cards), edited, 'phone').items)[0] === firstText.id);
  ok('add on desktop: hidden stays hidden, the height stays set',
    J(withAdds.hidden) === J([kpis[2].id]) && withAdds.items.find((i: any) => i.id === note.id).h === 5);
  const removed = added.filter((c) => c.id !== halves[0].id && c.id !== kpis[2].id);
  const withRemove = sl.resolve(removed, edited, 'phone');
  ok('remove on desktop: the removed cards drop out of the layout and the hidden list',
    !ids(withRemove.items).includes(halves[0].id) && withRemove.hidden.length === 0, J(withRemove));
  ok('remove on desktop: everything else keeps the edited order',
    J(ids(withRemove.items)) === J(order.filter((id) => id !== halves[0].id)), J(ids(withRemove.items)));

  // Main's whitelist and a real save.
  const control = { id: uuid(4), type: 'control', layout: { x: 0, y: 0, w: 0, h: 0 }, control: { kind: 'dropdown', label: 'Region', datasetId: kpis[0].metric.datasetId, column: 'region' } };
  const dirty: any = {
    id: sheet.id, name: sheet.name, cards: cards.concat([control]),
    layouts: {
      phone: { items: edited.items.concat([
        { id: control.id }, { id: uuid(99) }, { id: map.id, hidden: true }, { id: 7 },
      ]).map((i: any) => (i.id === note.id ? { ...i, h: 400, colour: 'red' } : i)) },
      tablet: { items: [{ id: kpis[0].id, hidden: 'yes', h: 'tall' }] },
      desktop: { items: [{ id: kpis[0].id }] },
      watch: { items: [{ id: kpis[0].id }] },
    },
  };
  const clean: any = dashboards.sanitizePage(dirty);
  const cp = clean.layouts.phone.items;
  ok('sanitize: known tiles only — a control, an unknown id and a non-string id are dropped, a repeat is ignored',
    J(ids(cp)) === J(ids(edited.items)), J(ids(cp)));
  ok('sanitize: heights clamp, unknown item keys drop', J(cp.find((i: any) => i.id === note.id)) === J({ id: note.id, h: sl.MAX_H }));
  ok('sanitize: `hidden` survives only as true', cp.find((i: any) => i.id === kpis[2].id).hidden === true
    && J(clean.layouts.tablet.items) === J([{ id: kpis[0].id }]));
  ok('sanitize: only tablet and phone are stored sizes', J(Object.keys(clean.layouts).sort()) === J(['phone', 'tablet']));
  ok('sanitize: a page with no valid layout carries no `layouts` key',
    !('layouts' in dashboards.sanitizePage({ ...sheet, layouts: { phone: { items: [{ id: uuid(98) }] } } })));

  await analysis.updateAnalysis(pid, aid, { sheets: [{ ...sheet, layouts: { phone: edited } }] });
  const saved = await analysis.getAnalysis(pid, aid);
  ok('save: an edited phone layout survives the record round trip, verbatim',
    !!saved && J(saved.sheets[0].layouts) === J({ phone: edited }), J(saved && saved.sheets[0].layouts));

  // ── 4. Publish ─────────────────────────────────────────────────────────────
  const cells = dashboards.sizeLayout.publishCells(cards, { phone: edited });
  ok('publish: every tile gets a tablet cell and a phone cell or a hidden mark',
    cards.every((c) => cells[c.id] && cells[c.id].tablet && cells[c.id].phone));
  ok('publish: the KPI hidden on phone is hidden there and placed on tablet',
    J(cells[kpis[2].id].phone) === J({ hidden: true }) && J(cells[kpis[2].id].tablet) === J({ x: 4, y: 0, w: 2, h: 2 }), J(cells[kpis[2].id]));
  ok('publish: the cells are exactly the hub\'s resolve', J(cells[map.id].phone) === J((({ id: _i, ...r }) => r)(before.items[0])));
  const page: any = sanitizePublished({ kind: 'dashboard', site: {}, dashboard: { name: 'D', controls: [], keys: [''], sheets: [{ name: 'S', cards: [
    { kind: 'metric', title: 'K', layout: { x: 0, y: 0, w: 3, h: 2 }, variants: [0], payloads: [{ value: 1, display: '1' }],
      sizes: { tablet: { x: 0, y: 0, w: 2, h: 2, z: 1 }, phone: { hidden: true, x: 3 }, watch: { x: 1 } } },
    { kind: 'text', title: '', heading: 'H', text: 'T', layout: {}, sizes: 'nope' },
  ] }] } });
  const pc0 = page.dashboard.sheets[0].cards[0];
  ok('publish sanitize: sizes keep coordinates or a hidden mark, nothing else',
    J(pc0.sizes) === J({ tablet: { x: 0, y: 0, w: 2, h: 2 }, phone: { hidden: true } }), J(pc0.sizes));
  ok('publish sanitize: junk sizes become none', J(page.dashboard.sheets[0].cards[1].sizes) === J({}));

  // ── 5. Reports use desktop ─────────────────────────────────────────────────
  const shape = (pages: any[]): string => J(pages.map((p) => [p.kind, p.sheetIdx, p.cardId, p.layout]));
  const hideChart = sl.materialize(cards, undefined);
  sl.setHidden(hideChart, halves[1].id, true);
  sl.moveItem(hideChart, map.id, kpis[0].id, false);
  const plain = reportSpec.defaultPages([{ ...sheet, layouts: undefined } as any]); // any: a Page with its layouts stripped
  const withLayouts = reportSpec.defaultPages([{ ...sheet, layouts: { phone: hideChart, tablet: edited } } as any]); // any: as above
  ok('reports: the default page list ignores tablet/phone layouts — same pages, same tiles, same order',
    shape(plain) === shape(withLayouts), shape(withLayouts));
  ok('reports: …and a chart hidden (and a map moved) on phone keeps its own page, in desktop order',
    withLayouts.filter((p) => p.kind === 'tile').map((p) => p.cardId).join() === plain.filter((p) => p.kind === 'tile').map((p) => p.cardId).join()
      && withLayouts.some((p) => p.cardId === halves[1].id));

  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* temp dir */ }
}

main()
  .then(() => {
    if (failureCount()) {
      console.error('\n' + failureCount() + ' size-layout check(s) FAILED');
      process.exit(1);
    }
    console.log('\nAll size-layout checks passed.');
  })
  .catch((err) => { console.error(err); process.exit(1); });
