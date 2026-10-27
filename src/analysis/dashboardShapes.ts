// DASHBOARD SHAPES — the named design recipes a drafted dashboard is built from.
// PURE DATA, imported by the server (the draft's facts, its validator and the
// build) and by the web (the wizard's picker draws `art`).
//
// One registry, one entry per shape, like src/connectors/: a new shape is a new
// entry, never a new branch somewhere else. Each entry says, in the plan's own
// vocabulary, how the dashboard is laid out on the 12-column grid, which chart
// kinds answer which question, how titles read and where the takeaway goes —
// and `shapeText` writes the model's sentence FROM those fields, so the prompt
// cannot drift from the data (scripts/test-dashboardShapes.ts checks every row
// and chart word against the plan's vocabularies).
//
// A shape chooses arrangement, chart kinds and words. It never carries a figure:
// the takeaway sentence is the app's caption of the lead chart
// (analysis/captions.ts), and a model-written note that holds a digit is dropped.

// No imports: the web bundles this file.

/** One box of a shape's picture: what sits there, and where on the 12-column grid. */
export type ShapeBox = [kind: 'visual' | 'metric' | 'text' | 'control', x: number, y: number, w: number, h: number];

export interface DashboardShape {
  id: string;
  title: string;
  /** The wizard's one line under the title. */
  hint: string;
  /** The shape in miniature, on the 12-column grid. */
  art: ShapeBox[];
  /** The arrangement, in the plan's row words (planRows.ROW_TYPES). */
  layout: string;
  /** Which chart kinds answer which question (analysisPlan.CHART_TYPE_IDS). */
  questions: { ask: string; charts: string[] }[];
  /** How titles and notes read. */
  titles: string;
  /** Where the takeaway sentence goes. The app writes it; the model never does. */
  takeaway: string;
  /** A KPI tile's size on the grid, when the shape wants bigger tiles than a strip's. */
  kpi?: { w: number; h: number };
  /** A chart's height in grid rows, when the shape wants taller charts. */
  chartH?: number;
  /** Every KPI shows its small trend and the change in its latest period (CardMetric.trend). */
  kpiTrend?: boolean;
  /** Charts draw their first series in the accent and the rest muted (chartFormat `accent`). */
  accent?: boolean;
  /** Its tables sort, search and carry bars in their cells (chartFormat `richTable`). */
  richTable?: boolean;
}

const TAKEAWAY_HEADER = 'The app writes the takeaway sentence under the title from the first chart\'s own figures, so do not write one.';

export const DASHBOARD_SHAPES: readonly DashboardShape[] = [
  {
    id: 'scorecard',
    title: 'Scorecard',
    hint: 'Four to six KPI tiles, each with its change and a small trend.',
    art: [['metric', 0, 0, 4, 3], ['metric', 4, 0, 4, 3], ['metric', 8, 0, 4, 3], ['metric', 0, 3, 4, 3], ['metric', 4, 3, 4, 3], ['metric', 8, 3, 4, 3], ['visual', 0, 6, 12, 4]],
    layout: 'One sheet. Open on a "kpis" row of four to six KPIs, one per measure that matters, then at most one "charts" row with one chart.',
    questions: [
      { ask: 'Which measures matter most?', charts: [] },
      { ask: 'How has the main measure moved over time?', charts: ['line', 'area'] },
    ],
    titles: 'Label each KPI with what it measures in two or three words, sentence case ("Revenue", "Active customers"). Each KPI shows its own trend and change; the app computes both.',
    takeaway: TAKEAWAY_HEADER,
    kpi: { w: 4, h: 3 },
    kpiTrend: true,
  },
  {
    id: 'review',
    title: 'Review',
    hint: 'A few totals, one large chart over time, then small multiples on one scale.',
    art: [['metric', 0, 0, 3, 2], ['metric', 3, 0, 3, 2], ['metric', 6, 0, 3, 2], ['metric', 9, 0, 3, 2], ['visual', 0, 2, 12, 5], ['visual', 0, 7, 6, 3], ['visual', 6, 7, 6, 3]],
    layout: 'One sheet. A "kpis" row of two to four totals, then a "charts" row holding ONE chart over the date column, then a "charts" row holding one chart split into small multiples: give its encoding "facet": {"cols":"<a category column with few values>","scale":"shared"} so every panel shares one scale.',
    questions: [
      { ask: 'How did it move over time?', charts: ['line', 'area', 'column'] },
      { ask: 'How does each group compare on the same scale?', charts: ['line', 'column', 'bar'] },
    ],
    titles: 'Title each chart in sentence case with what it shows ("Revenue by month"). Give each chart a "note": one line on what to look at, with no figures.',
    takeaway: TAKEAWAY_HEADER,
    chartH: 7,
  },
  {
    id: 'visual',
    title: 'Visual analysis',
    hint: 'A headline sentence around one number, then one chart per question.',
    art: [['text', 0, 0, 12, 1], ['visual', 0, 1, 12, 4], ['visual', 0, 5, 8, 4], ['text', 8, 5, 4, 4], ['visual', 0, 9, 12, 3]],
    layout: 'One sheet read top to bottom: two to four sections, each ONE chart answering one question — a "charts" row with one chart, or an "annotated" row when a note beside it helps. No KPI row.',
    questions: [
      { ask: 'Who leads, and by how much?', charts: ['bar', 'column', 'pareto'] },
      { ask: 'What share does each take?', charts: ['treemap', 'donut', 'pct_stacked_bar'] },
      { ask: 'How has it changed?', charts: ['line', 'area'] },
      { ask: 'How do two measures relate?', charts: ['scatter', 'bubble'] },
      { ask: 'Where is it?', charts: ['map_choropleth', 'map_bubble'] },
    ],
    titles: 'Title each chart with the question it answers, in sentence case ("Where do customers live?", "Who grew fastest?"), and give it a "note": one line saying what to look at, with no figures. Put the measure that matters first: the app draws the first series in the accent and the rest muted.',
    takeaway: 'The app writes the headline sentence under the title from the first chart\'s own figures — its leader and by how much — so do not write one.',
    accent: true,
  },
  {
    id: 'table',
    title: 'Table',
    hint: 'One sortable, searchable table with bars in its cells.',
    art: [['control', 0, 0, 3, 1], ['control', 3, 0, 3, 1], ['visual', 0, 1, 12, 9]],
    layout: 'One sheet holding ONE "charts" row with ONE "table" chart: the category is what each row is, and two to four measures are its columns. Add "controls" for the columns a reader would narrow it by.',
    questions: [
      { ask: 'How does every row rank?', charts: ['table'] },
    ],
    titles: 'Title the table with what each row is, in sentence case ("Every state, by population"), and give it a "note": one line on how to read it, with no figures. Readers sort it, search it and read bars in its cells.',
    takeaway: TAKEAWAY_HEADER,
    chartH: 10,
    richTable: true,
  },
];

/** The shape a stored or sent id names, or undefined — `hasOwn`-free: the registry is an array. */
export function shapeOf(id: unknown): DashboardShape | undefined {
  return typeof id === 'string' ? DASHBOARD_SHAPES.find((s) => s.id === id) : undefined;
}

/** What the browser sends when the person left the shape to the Assistant. */
export const AUTO_SHAPE = 'auto';

/** One shape as the model reads it — every word from the entry. */
function describe(s: DashboardShape): string {
  const qs = s.questions.filter((q) => q.charts.length).map((q) => `"${q.ask}" → ${q.charts.join(' or ')}`).join('; ');
  return `${s.title.toUpperCase()} (shape "${s.id}"): ${s.hint} ${s.layout} Charts by question: ${qs}. ${s.titles} ${s.takeaway}`;
}

/**
 * The app's sentence for the draft's facts: the chosen shape, the menu when the
 * person left it to the Assistant (`AUTO_SHAPE`), or '' for anything else — so
 * a caller that never asks (story:draft, automation) sends what it always sent.
 */
export function shapeText(id: unknown): string {
  const s = shapeOf(id);
  if (s) return `The user chose this dashboard shape. Follow it, and set "shape" to "${s.id}". ${describe(s)}`;
  if (id !== AUTO_SHAPE) return '';
  return [
    'Pick the ONE dashboard shape below that best answers the request, follow it, and set "shape" to its id:',
    ...DASHBOARD_SHAPES.map((s) => `- ${describe(s)}`),
  ].join('\n');
}

/** A card's note (dashboards.Card.note): one line — line breaks folded, capped — or '' for none. */
export const CARD_NOTE_MAX = 140;
export function cardNote(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, CARD_NOTE_MAX).trim() : '';
}

/**
 * A model-written note under a chart's title: one capped line, or '' — and ''
 * for any note holding a digit. A note says what to look at; a figure in it would
 * be a model writing a number, which the app never shows.
 */
export function planNote(raw: unknown): string {
  const note = cardNote(raw);
  return /\d/.test(note) ? '' : note;
}
