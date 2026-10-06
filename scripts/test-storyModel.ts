// Self-check for the STORY record — src/analysis/storyModel.ts (the block
// whitelist) and src/analysis/stories.ts (the store), plus the Assistant's
// plan → blocks mapping in src/ipc/stories.ts.
//
// The block model is a trust boundary twice over: blocks arrive from the
// renderer on every keystroke-debounced save, and come back off disk on every
// open. So each kind is pinned for what it KEEPS, what it DROPS and what it
// REFUSES — an SVG image, a non-UUID reference, a key nobody asked for.
//
//   npm run build:ts && node scripts/test-storyModel.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-stories-'));
process.env.ORDINATE_LOCAL_DIR = tmpUserData;

const M: typeof import('../src/analysis/storyModel') = require('../src/analysis/storyModel');
const stories: typeof import('../src/analysis/stories') = require('../src/analysis/stories');
const projects: typeof import('../src/app/projects') = require('../src/app/projects');
const metrics: typeof import('../src/analysis/metrics') = require('../src/analysis/metrics');
const datasets: typeof import('../src/data/datasets') = require('../src/data/datasets');
const storiesIpc: typeof import('../src/ipc/stories') = require('../src/ipc/stories');

const V = '11111111-1111-4111-8111-111111111111';
const MID = '22222222-2222-4222-8222-222222222222';
const MID2 = '33333333-3333-4333-8333-333333333333';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

// ── Block validation, kind by kind ──────────────────────────────────────────

const t = M.sanitizeBlock({ id: 'b1', kind: 'text', text: '# Title', extra: 'x' });
ok('text: kept, id kept, unknown key dropped', !!t && t.kind === 'text' && t.id === 'b1' && t.text === '# Title' && !('extra' in t));
ok('text: runaway text is clamped', (M.sanitizeBlock({ kind: 'text', text: 'a'.repeat(M.MAX_TEXT + 10) }) as any).text.length === M.MAX_TEXT);
ok('text: a non-string text becomes empty, not "undefined"', (M.sanitizeBlock({ kind: 'text', text: 42 }) as any).text === '');
ok('id: a missing or path-like id is replaced with a fresh one',
  /^[0-9a-f-]{36}$/.test((M.sanitizeBlock({ kind: 'divider' }) as any).id) && (M.sanitizeBlock({ id: '../x', kind: 'divider' }) as any).id !== '../x');

const vis = M.sanitizeBlock({ kind: 'visual', visualId: V, caption: 'Look here', filters: [
  { type: 'filter', column: 'region', op: '=', value: 'West' },
  { type: 'dedupe' },
  { type: 'filter', column: 'x', op: 'drop table' },
] }) as any;
ok('visual: reference, caption and FILTER steps kept; other steps dropped',
  vis && vis.visualId === V && vis.caption === 'Look here' && vis.filters.length === 1 && vis.filters[0].column === 'region', JSON.stringify(vis));
ok('visual: no caption means the app\'s caption (the key is absent, not empty)', !('caption' in (M.sanitizeBlock({ kind: 'visual', visualId: V }) as any)));
ok('visual: a non-UUID visualId is refused', M.sanitizeBlock({ kind: 'visual', visualId: 'abc' }) === null);
ok('metric: kept with its pinned filters', (M.sanitizeBlock({ kind: 'metric', metricId: MID, filters: [] }) as any).metricId === MID);
ok('metric: a non-UUID metricId is refused', M.sanitizeBlock({ kind: 'metric', metricId: '../../etc' }) === null);
const row = M.sanitizeBlock({ kind: 'metrics_row', metricIds: [MID, MID, 'bad', MID2, V, '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'] }) as any;
ok('metrics_row: bad ids dropped, duplicates collapsed, at most four', row && row.metricIds.length === 4 && row.metricIds[0] === MID && row.metricIds[1] === MID2, JSON.stringify(row));
ok('metrics_row: none left → refused', M.sanitizeBlock({ kind: 'metrics_row', metricIds: ['x'] }) === null);
ok('image: a raster data: URL is kept', (M.sanitizeBlock({ kind: 'image', src: PNG, alt: 'dot' }) as any).src === PNG);
ok('image: an SVG data: URL is refused (a document that can carry script)',
  M.sanitizeBlock({ kind: 'image', src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }) === null);
ok('image: a file: or http: URL is refused', M.sanitizeBlock({ kind: 'image', src: 'file:///etc/passwd' }) === null
  && M.sanitizeBlock({ kind: 'image', src: 'https://example.com/x.png' }) === null);
ok('image: over the size cap is refused', M.sanitizeBlock({ kind: 'image', src: 'data:image/png;base64,' + 'A'.repeat(M.MAX_IMAGE_CHARS) }) === null);
ok('callout: an unknown tone becomes info', (M.sanitizeBlock({ kind: 'callout', tone: 'rainbow', text: 'x' }) as any).tone === 'info');
ok('callout: a known tone is kept', (M.sanitizeBlock({ kind: 'callout', tone: 'warning', text: 'x' }) as any).tone === 'warning');
ok('divider: kept, carries nothing else', JSON.stringify(Object.keys(M.sanitizeBlock({ kind: 'divider', text: 'x' }) as any).sort()) === '["id","kind"]');
ok('unknown kind → refused', M.sanitizeBlock({ kind: 'script', text: 'x' }) === null && M.sanitizeBlock(null) === null && M.sanitizeBlock('text') === null);
ok('every kind in the list is accepted in some form',
  M.STORY_BLOCK_KINDS.every((k) => M.sanitizeBlock({ kind: k, text: '', visualId: V, metricId: MID, metricIds: [MID], src: PNG }) !== null));

const list = M.sanitizeBlocks([{ id: 'a', kind: 'text', text: 'one' }, { kind: 'bogus' }, { id: 'a', kind: 'divider' }]);
ok('list: invalid blocks dropped, a duplicate id re-issued', list.length === 2 && list[0].id === 'a' && list[1].id !== 'a');
ok('list: never empty — an empty story is one empty paragraph', JSON.stringify(M.sanitizeBlocks([]).map((b) => b.kind)) === '["text"]'
  && M.sanitizeBlocks('nonsense').length === 1);
ok('list: capped', M.sanitizeBlocks(Array.from({ length: M.MAX_BLOCKS + 5 }, () => ({ kind: 'divider' }))).length === M.MAX_BLOCKS);
const refs = M.storyRefs([vis, { id: 'm', kind: 'metric', metricId: MID, filters: [] }, row]);
ok('refs: every visual and metric a story points at, once', refs.visualIds.join() === V && refs.metricIds.length === 4 && refs.metricIds[0] === MID);
ok('starter: a title heading and a line to type into', JSON.stringify(M.starterBlocks('Q4 review').map((b: any) => b.text)) === '["# Q4 review",""]');

// ── The store ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const p = await projects.createProject('Stories');
  const pid = p!.id;
  const s = await stories.saveStory(pid, { name: '  Q4   review ' });
  ok('store: a new story opens on its title and an empty line', !!s && s.name === 'Q4 review' && s.blocks.length === 2 && (s.blocks[0] as any).text === '# Q4 review');
  const upd = await stories.updateStory(pid, s!.id, { blocks: [{ kind: 'text', text: '## Revenue\nWest leads.' }, { kind: 'visual', visualId: V }, { kind: 'image', src: 'data:image/svg+xml;base64,AA==' }] });
  ok('store: blocks are REPLACED and re-sanitised on the way in (the SVG is gone)', !!upd && upd.blocks.length === 2 && upd.name === 'Q4 review');
  const back = await stories.getStory(pid, s!.id);
  ok('store: round-trips from disk', !!back && back.blocks[1].kind === 'visual' && (back.blocks[1] as any).visualId === V);
  const file = path.join(tmpUserData, 'projects', pid, 'stories', s!.id + '.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.blocks.push({ kind: 'image', src: ['javascript', 'alert(1)'].join(':') }); // assembled, so the lint rule sees data, not a URL
  raw.projectId = 'someone-else';
  fs.writeFileSync(file, JSON.stringify(raw));
  const reread = await stories.getStory(pid, s!.id);
  ok('store: a hand-edited file is re-sanitised on the way OUT, and keeps its own project', !!reread && reread.blocks.length === 2 && reread.projectId === pid);
  const listed = await stories.listStories(pid);
  ok('store: the list carries name, length and the first line of prose', listed.length === 1 && listed[0].blockCount === 2 && listed[0].excerpt === 'West leads.', JSON.stringify(listed));
  fs.writeFileSync(path.join(tmpUserData, 'projects', pid, 'stories', '66666666-6666-4666-8666-666666666666.json'), '{not json');
  ok('store: a corrupt file is skipped, not fatal', (await stories.listStories(pid)).length === 1);
  ok('store: ids are validated before any path', (await stories.getStory(pid, '../../x')) === null && (await stories.saveStory('../x', {})) === null);
  ok('store: a story in a missing project is refused', (await stories.saveStory('77777777-7777-4777-8777-777777777777', {})) === null);
  ok('store: delete', (await stories.deleteStory(pid, s!.id)) && (await stories.getStory(pid, s!.id)) === null);

  // ── The Assistant's plan records → a document ─────────────────────────────
  const ds = await datasets.saveDataset(pid, { name: 'Sales', sourceKind: 'csv', columns: [{ name: 'region', type: 'text' }, { name: 'revenue', type: 'number' }], rows: [['West', 1]] });
  const existing = await metrics.saveMetric(pid, { name: 'Revenue', datasetId: ds!.id, definition: { column: 'revenue', aggregation: 'sum' } });
  const blocks = await storiesIpc.blocksFromRecords(pid, {
    name: 'Regional story',
    sheets: [
      { name: 'Where revenue comes from', cards: [
        { type: 'metric', metric: { datasetId: ds!.id, column: 'revenue', aggregation: 'sum', label: 'Total revenue' } },
        { type: 'metric', metric: { datasetId: ds!.id, column: 'revenue', aggregation: 'avg', label: 'Average order' } },
        { type: 'visual', visualId: V },
        { type: 'text', heading: 'Read this', text: 'West leads.' },
      ] },
    ],
  }, 'Revenue by region, then what to watch.');
  const kinds = blocks.map((b) => b.kind).join(',');
  ok('plan → blocks: title, rationale, a section heading, the KPIs as a row, the chart, the note',
    kinds === 'text,text,text,metrics_row,visual,text', kinds);
  ok('plan → blocks: headings are Markdown', (blocks[0] as any).text === '# Regional story' && (blocks[2] as any).text === '## Where revenue comes from');
  const rowIds = (blocks[3] as any).metricIds as string[];
  const all = await metrics.listMetrics(pid);
  ok('plan → blocks: a KPI matching an existing metric REUSES it; a new one is saved once, named by its label',
    rowIds[0] === existing!.id && all.length === 2 && all.some((m) => m.name === 'Average order' && m.id === rowIds[1]), JSON.stringify(all.map((m) => m.name)));
  ok('plan → blocks: every block survives the whitelist', M.sanitizeBlocks(blocks).length === blocks.length);
  finish();
}

main().catch((e) => { console.error(e); process.exit(1); });
