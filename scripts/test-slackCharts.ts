// Ordinate in Slack, phase 4: the `data_visualization` mapping and every fallback (docs/slack/00-design.md, "Charts").
// Pure: no database, no network. A chart is used only when the result fits exactly; each limit has a boundary that passes
// and a case that falls back to the table.
//
//   npm run build:ts && node scripts/test-slackCharts.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';

const charts: typeof import('../src/server/slack/charts') = require('../src/server/slack/charts');
const render: typeof import('../src/server/slack/render') = require('../src/server/slack/render');

type Series = { name: string; values: Array<number | null>; role?: 'overlay' };
const card = (chartType: string, labels: Array<string | number>, series: Series[], title = 'Sales by region'): Record<string, unknown> => ({ ok: true, title, chartType, data: { labels, series } });
const L = ['East', 'West', 'North'];
const S = (n: string, v: number[]): Series => ({ name: n, values: v });
const block = (c: Record<string, unknown>) => charts.chartBlock(c) as { type: string; title: string; chart: Record<string, any> } | null; // any: Slack's chart payload

for (const [ours, theirs] of [['column', 'bar'], ['clustered_column', 'bar'], ['line', 'line'], ['line_markers', 'line'], ['area', 'area']] as const) {
  const b = block(card(ours, L, [S('2024', [1, 2, 3]), S('2023', [3, 2, 1])]));
  ok(`Map: ${ours} becomes a Slack ${theirs} chart, series by name, one point per category, categories in order`,
    b?.type === 'data_visualization' && b.chart.type === theirs && b.chart.series.length === 2 && b.chart.series[0].name === '2024'
    && b.chart.series[1].data.map((p: { label: string; value: number }) => `${p.label}=${p.value}`).join() === 'East=3,West=2,North=1' && b.chart.axis_config.categories.join() === 'East,West,North', JSON.stringify(b));
}
for (const t of ['pie', 'donut']) {
  const b = block(card(t, L, [S('Revenue', [5, 3, 2])]));
  ok(`Map: ${t} with every value above 0 becomes a pie of segments`, b?.chart.type === 'pie' && b.chart.segments.map((s: { label: string; value: number }) => `${s.label}=${s.value}`).join() === 'East=5,West=3,North=2', JSON.stringify(b));
}
ok('Map: the values are the card\'s own numbers, passed through unchanged (none computed here)', block(card('column', ['a'], [S('x', [0.1 + 0.2])]))?.chart.series[0].data[0].value === 0.1 + 0.2);

const none = (name: string, c: Record<string, unknown>) => ok(`Fallback: ${name} — a table, not a chart`, charts.chartBlock(c) === null && render.tableOf(c) !== null);
for (const t of ['stacked_column', 'pct_stacked_column', 'stacked_area', 'scatter', 'gauge', 'treemap', 'funnel', 'map', 'pivot', 'bar', 'heatmap']) none(`${t} cannot be drawn exactly by Slack`, card(t, L, [S('a', [1, 2, 3])]));
none('21 points is more than Slack\'s 20 per series', card('line', Array.from({ length: 21 }, (_, i) => `p${i}`), [S('a', Array.from({ length: 21 }, (_, i) => i))]));
ok('Boundary: exactly 20 points passes', block(card('line', Array.from({ length: 20 }, (_, i) => `p${i}`), [S('a', Array.from({ length: 20 }, (_, i) => i))])) !== null);
none('13 series is more than Slack\'s 12', card('column', L, Array.from({ length: 13 }, (_, i) => S(`s${i}`, [1, 2, 3]))));
ok('Boundary: exactly 12 series passes', block(card('column', L, Array.from({ length: 12 }, (_, i) => S(`s${i}`, [1, 2, 3])))) !== null);
none('two categories that collide after 20 characters', card('column', ['A very long category name 1', 'A very long category name 2'], [S('a', [1, 2])]));
none('two series that collide after 20 characters', card('column', L, [S('A very long series name 1', [1, 2, 3]), S('A very long series name 2', [1, 2, 3])]));
ok('Boundary: long but distinct labels are cut to 20 characters and pass', block(card('column', ['A very long category name 1', 'B very long category name 2'], [S('a', [1, 2])]))?.chart.axis_config.categories.every((c: string) => c.length <= 20) === true);
none('a pie with a zero value (it has no share)', card('pie', L, [S('Revenue', [5, 0, 2])]));
none('a pie with a negative value', card('pie', L, [S('Revenue', [5, -1, 2])]));
none('a pie of two series', card('pie', L, [S('a', [1, 2, 3]), S('b', [1, 2, 3])]));
none('13 pie segments', card('pie', Array.from({ length: 13 }, (_, i) => `s${i}`), [S('a', Array.from({ length: 13 }, () => 1))]));
none('a missing value (a series needs one point per category)', card('line', L, [{ name: 'a', values: [1, null, 3] }]));
none('a value that is not a finite number', card('line', L, [{ name: 'a', values: [1, Number.NaN, 3] }]));
none('a title over 50 characters', card('column', L, [S('a', [1, 2, 3])], 'x'.repeat(51)));
none('no title', card('column', L, [S('a', [1, 2, 3])], ''));
none('an empty category label', card('column', ['East', '', 'North'], [S('a', [1, 2, 3])]));
ok('Boundary: a 50-character title passes', block(card('column', L, [S('a', [1, 2, 3])], 'x'.repeat(50))) !== null);
ok('Negative values are allowed in bar, line and area charts', block(card('area', L, [S('a', [-1, 2, -3])])) !== null);
none('an SQL answer (a table of rows) is never drawn as a chart here', { kind: 'sql', title: 't', columns: [{ name: 'a' }], rows: [['x']], chartType: 'column', data: { labels: ['x'], series: [S('a', [1])] } });

const m = render.answerMessage({ sentence: 'East leads.', masked: false, card: card('column', L, [S('a', [1, 2, 3])]), agent: null, datasets: [], questionId: '11111111-1111-1111-1111-111111111111', openUrl: null, chart: charts.chartBlocks(card('column', L, [S('a', [1, 2, 3])])) });
ok('Message: a chart replaces the table and the sentence always stays (the block has no alt text)', m.blocks.some((b) => (b as { type: string }).type === 'data_visualization') && !m.blocks.some((b) => (b as { type: string }).type === 'table') && /East leads/.test(JSON.stringify(m.blocks)));
const m2 = render.answerMessage({ sentence: 'x', masked: false, card: card('stacked_column', L, [S('a', [1, 2, 3])]), agent: null, datasets: [], questionId: '11111111-1111-1111-1111-111111111111', openUrl: null, chart: charts.chartBlocks(card('stacked_column', L, [S('a', [1, 2, 3])])) });
ok('Message: a result that does not fit falls back to the table', m2.blocks.some((b) => (b as { type: string }).type === 'table') && !m2.blocks.some((b) => (b as { type: string }).type === 'data_visualization'));
ok('Message: at most 2 chart blocks per message (one is ever built)', (charts.chartBlocks(card('column', L, [S('a', [1, 2, 3])])) as unknown[]).length <= 2);

finish();
