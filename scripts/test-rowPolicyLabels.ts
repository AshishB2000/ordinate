// R19: a restricted viewer is sent no label from rows they may not see —
// through every path that returns a stored visual (docs/sso-lifecycle/00-design.md
// §2.7, §3.12), over the real RPC route as real users (scripts/rowPolicyHarness).
//
// *Orders* has rules; `east` is a restricted viewer (team East), `ed` an editor.
//
// 1. EVERY PATH: visual:get, visual:thumbs, versions:get (visual and dashboard),
//    analysis:gallery, analysis:open (its visuals and the dashboard's inline
//    card.visual) and story:figures send east no West label: no waterfall
//    totals, custom order, series colours or drivers path value of West's.
//    NEGATIVE CONTROL: the editor gets every one of them.
// 2. THE WATERFALL STILL MARKS ITS TOTALS: east's chart asked with the visual's
//    id (no totals sent) marks exactly what the editor's chart over the PHYSICAL
//    East twin marks with the stored totals — Object.is, step by step.
//    NEGATIVE CONTROL: without the id, east's chart marks none of them.
// 3. DUAL AXIS: east keeps exactly the y2 names that are series of their own
//    locked reply; a raw y2 name planted in a VERSION (normalize would clamp a
//    live record) is dropped. NEGATIVE CONTROL: the editor gets the planted name.
// 4. TAGS: east's tags are of what east was sent, never the stored ones.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-rowPolicyLabels.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './rowPolicyHarness';

const versionsMod: typeof import('../src/app/versions') = require('../src/app/versions');
const visualsMod: typeof import('../src/analysis/visuals') = require('../src/analysis/visuals');
const tags: typeof import('../src/app/editConflict') = require('../src/app/editConflict');

const totalsOf = (r: H.Reply): string[] =>
  ((r.body?.data?.figures?.waterfall?.steps ?? []) as { label: string; kind: string }[]).filter((s) => s.kind === 'total').map((s) => s.label);

(async () => {
  const W = await H.world('row policy labels');
  if (!W) return finish();
  try {
    const { P, orders, east } = W;
    const canary = (n: number) => `${H.W_CANARY}_${n}`;
    const enc = { category: 'customer', values: [{ column: 'sales', aggregation: 'sum' }] };
    const stored = ['c1', canary(2)];
    const save = async (body: Record<string, unknown>) => {
      const r = await W.call('boss', 'visual:save', { projectId: P, datasetId: orders, ...body });
      return String(r.body?.visual?.id ?? r.body?.id ?? '');
    };
    const wf = await save({ name: 'Bridge', chartType: 'waterfall', encoding: enc, overrides: { waterfallTotals: stored, sort: 'custom', sortOrder: [canary(3)], seriesColors: { [canary(4)]: 'chart-2' } } });
    const dualEnc = { category: 'customer', values: [{ column: 'sales', aggregation: 'sum' }, { column: 'qty', aggregation: 'sum' }] };
    const dual = await save({ name: 'Two axes', chartType: 'combo', encoding: dualEnc, overrides: { y2Series: ['sum of qty'] } });
    const drv = await save({ name: 'Drivers', chartType: 'waterfall', encoding: { ...enc, drivers: { metric: { column: 'sales', aggregation: 'sum' }, compare: { mode: 'previous_period' }, path: [{ column: 'customer', value: canary(1) }] } } });
    const inline = { datasetId: orders, name: 'Inline', chartType: 'waterfall', encoding: enc, overrides: { waterfallTotals: [canary(0)] }, filters: [] };
    const card = (extra: Record<string, unknown>) => ({ id: crypto.randomUUID(), type: 'visual', layout: { x: 0, y: 0, w: 6, h: 4 }, ...extra });
    const made = await W.call('boss', 'analysis:create', { projectId: P, name: 'Board', sheets: [{ name: 'One', cards: [card({ visualId: wf })] }] });
    const dash = String(made.body?.id ?? made.body?.analysis?.id ?? '');
    await W.call('boss', 'analysis:update', { projectId: P, id: dash, sheets: [{ name: 'One', cards: [card({ visualId: wf }), card({ visualId: wf, visual: inline })] }] });
    ok('setup: the visuals and the dashboard', [wf, dual, drv, dash].every((x) => /^[0-9a-f-]{36}$/.test(x)), [wf, dual, drv, dash].join(' '));
    const storedInline = await W.as('boss', async () => JSON.stringify(await (require('../src/analysis/analysis') as typeof import('../src/analysis/analysis')).getAnalysis(P, dash)));
    ok('setup: the dashboard stores an inline card.visual with a West label (sanitizeCard keeps it)', storedInline.includes(canary(0)));

    // A raw dual-axis name in a VERSION record (versions are stored as given; normalize clamps the live one).
    const live = await W.as('boss', async () => visualsMod.getVisual(P, dual));
    await W.as('boss', () => versionsMod.record(P, 'visual', { ...live, overrides: { y2Series: ['sum of qty', canary(9)] } }));
    // versions:list is newest first.
    const vkey = async (type: string, id: string) => ((await W.call('boss', 'versions:list', { projectId: P, type, id })).body as { key: string }[]).map((x) => x.key);
    const dualKeys = await vkey('visual', dual);
    const dashKeys = await vkey('dashboard', dash);

    // ── 1. Every path ────────────────────────────────────────────────────
    const PATHS: [string, string, unknown][] = [
      ['visual:get (waterfall)', 'visual:get', { projectId: P, id: wf }],
      ['visual:get (drivers)', 'visual:get', { projectId: P, id: drv }],
      ['visual:thumbs', 'visual:thumbs', { projectId: P, ids: [wf, drv] }],
      ['versions:get (visual)', 'versions:get', { projectId: P, type: 'visual', id: wf, key: (await vkey('visual', wf))[0] }],
      ['versions:get (planted dual axis)', 'versions:get', { projectId: P, type: 'visual', id: dual, key: dualKeys[0] }],
      ['versions:get (dashboard)', 'versions:get', { projectId: P, type: 'dashboard', id: dash, key: dashKeys[0] }],
      ['analysis:gallery', 'analysis:gallery', { projectId: P }],
      ['analysis:open', 'analysis:open', { projectId: P, id: dash }],
      ['story:figures', 'story:figures', { projectId: P, blocks: [{ id: 'b1', kind: 'visual', visualId: wf }, { id: 'b2', kind: 'visual', visualId: drv }] }],
    ];
    for (const [label, channel, payload] of PATHS) {
      const mine = await W.call('east', channel, payload);
      const theirs = await W.call('ed', channel, payload);
      ok(`labels: ${label} sends east no West label`, mine.status === 200 && !H.leaks(mine.text), `${mine.status} ${mine.text.slice(0, 200)}`);
      ok(`NEGATIVE CONTROL: ${label} sends the editor the West label`, theirs.status === 200 && H.leaks(theirs.text), theirs.text.slice(0, 200));
    }
    const got = (await W.call('east', 'visual:get', { projectId: P, id: wf })).body;
    ok('labels: east\'s waterfall comes without totals, custom order or series colours; the rest of its styling stays',
      got.overrides.waterfallTotals === undefined && got.overrides.sortOrder === undefined && got.overrides.seriesColors === undefined && got.overrides.sort === 'custom', JSON.stringify(got.overrides));

    // ── 2. The waterfall still marks its totals (server-side, from the stored record) ──
    const askEast = await W.call('east', 'visual:data', { projectId: P, datasetId: orders, encoding: enc, chartType: 'waterfall', visualId: wf });
    const askTwin = await W.call('ed', 'visual:data', { projectId: P, datasetId: east, encoding: enc, chartType: 'waterfall', waterfallTotals: stored });
    const d = H.diff(askEast.body?.data?.figures, askTwin.body?.data?.figures, { [east]: orders });
    ok('waterfall: east\'s chart by visual id marks what the editor\'s chart over the East twin marks with the stored totals (Object.is)', askEast.body?.ok === true && d === '', d);
    ok('waterfall: …which is east\'s own label c1, drawn as a total', totalsOf(askEast).includes('c1') && !H.leaks(askEast.text), JSON.stringify(totalsOf(askEast)));
    const bare = await W.call('east', 'visual:data', { projectId: P, datasetId: orders, encoding: enc, chartType: 'waterfall' });
    ok('NEGATIVE CONTROL: without the visual id, east\'s chart marks no stored total', bare.body?.ok === true && !totalsOf(bare).includes('c1'), JSON.stringify(totalsOf(bare)));
    const elsewhere = await W.call('east', 'visual:data', { projectId: P, datasetId: east, encoding: enc, chartType: 'waterfall', visualId: wf });
    ok('waterfall: a visual id on ANOTHER dataset fills nothing', !totalsOf(elsewhere).includes('c1') || elsewhere.body?.ok === false, JSON.stringify(totalsOf(elsewhere)));
    const tiles = await W.call('east', 'analysis:tiles', { projectId: P, items: [{ kind: 'visual', datasetId: orders, encoding: enc, chartType: 'waterfall', visualId: wf }] });
    ok('waterfall: a dashboard tile by visual id marks the total too (analysis:tiles)', totalsOf({ ...tiles, body: tiles.body?.[0] }).includes('c1'), tiles.text.slice(0, 200));
    const thumbs = await W.call('east', 'visual:thumbs', { projectId: P, ids: [wf] });
    ok('waterfall: the gallery thumbnail marks it from the stored record, and sends no totals', totalsOf({ ...thumbs, body: thumbs.body?.[0] }).includes('c1') && thumbs.body?.[0]?.overrides?.waterfallTotals === undefined);

    // ── 3. Dual axis ─────────────────────────────────────────────────────
    const eastDual = (await W.call('east', 'visual:get', { projectId: P, id: dual })).body;
    const dualData = await W.call('east', 'visual:data', { projectId: P, datasetId: orders, encoding: dualEnc, chartType: 'combo' });
    const seriesNames = new Set(((dualData.body?.data?.series ?? []) as { name: string }[]).map((s) => s.name));
    const fromReply = ['sum of qty'].filter((n) => seriesNames.has(n));
    ok('dual axis: east keeps exactly the y2 names that are series of their own locked reply (differential)',
      JSON.stringify(eastDual.overrides.y2Series) === JSON.stringify(fromReply) && fromReply.length === 1, `${JSON.stringify(eastDual.overrides.y2Series)} vs ${JSON.stringify([...seriesNames])}`);
    const plantedEast = (await W.call('east', 'versions:get', { projectId: P, type: 'visual', id: dual, key: dualKeys[0] })).body;
    ok('dual axis: a planted raw y2 name in a version is dropped for east; the measure stays',
      JSON.stringify(plantedEast.record.overrides.y2Series) === '["sum of qty"]', JSON.stringify(plantedEast.record.overrides));

    // ── 4. Tags ──────────────────────────────────────────────────────────
    const storedTag = (await W.as('boss', () => visualsMod.readVisual(P, wf)))!.tag;
    const edGot = (await W.call('ed', 'visual:get', { projectId: P, id: wf })).body;
    const { tag: _t, ...sent } = got;
    ok('tag: east\'s visual:get tag is of what east was sent, not the stored one', got.tag !== storedTag && got.tag === tags.contentTag('visual', sent));
    ok('NEGATIVE CONTROL: the editor gets the stored tag (the editor\'s base)', edGot.tag === storedTag);
    const openEast = (await W.call('east', 'analysis:open', { projectId: P, id: dash })).body;
    const openEd = (await W.call('ed', 'analysis:open', { projectId: P, id: dash })).body;
    const vt = (b: { visuals: { id: string; tag: string }[] }) => b.visuals.find((x) => x.id === wf)?.tag;
    ok('tag: analysis:open\'s visual and dashboard tags are of what east was sent',
      vt(openEast) !== vt(openEd) && openEast.tag !== openEd.tag && openEast.tag === tags.contentTag('dashboard', openEast.analysis));
  } finally {
    await W.close();
  }
  finish();
})().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
