// A plan sheet's ROWS — the arrangement vocabulary, validated.
//
// Split out of analysisPlan.ts rather than added to it (.claude/rules/
// file-size.md), like planControls.ts.
//
// Every drafted dashboard used to look the same, because a plan could not say
// where anything goes: one packer decided "KPI strip, charts two-up, notes" for
// every sheet. A row is how a plan says it WITHOUT geometry. It names one of
// five arrangements and what sits in it, and planLayout.ts turns that into
// coordinates. A plan still cannot name an x, a y, a width or a height, so there
// is still nothing for a model to get wrong or to abuse.
//
// What sits in a row is validated by the SAME validateVisual / validateMetric /
// validateText a flat sheet goes through. They are handed in as callbacks, so
// there is no second validator and no import cycle: this file takes only TYPES
// from analysisPlan.ts.

import type { PlanDrop, PlannedMetric, PlannedText, PlannedVisual } from './analysisPlan';

/** The CLOSED row vocabulary. An invented type is dropped, never coerced. */
export const ROW_TYPES = ['kpis', 'charts', 'spotlight', 'annotated', 'note'] as const;
export type RowType = (typeof ROW_TYPES)[number];

export type PlanRow =
  /** A strip of KPI tiles, four to a line. */
  | { type: 'kpis'; metrics: PlannedMetric[] }
  /** One chart at full width, or two side by side. */
  | { type: 'charts'; visuals: PlannedVisual[] }
  /** One wide chart with two or three KPIs stacked in the rail beside it. */
  | { type: 'spotlight'; visual: PlannedVisual; metrics: PlannedMetric[] }
  /** One wide chart with a note beside it. */
  | { type: 'annotated'; visual: PlannedVisual; text: PlannedText }
  /** A full-width note. */
  | { type: 'note'; text: PlannedText };

/** Everything in a row, or in a stack of them, by kind — a sheet's flat arrays. */
export interface RowItems {
  metrics: PlannedMetric[];
  visuals: PlannedVisual[];
  texts: PlannedText[];
}

/** analysisPlan's own item validators, closed over its context and its drops. */
export interface RowValidators {
  visual: (raw: unknown, where: string, at: string) => PlannedVisual | null;
  metric: (raw: unknown, where: string, at: string) => PlannedMetric | null;
  text: (raw: unknown, where: string, at: string) => PlannedText | null;
}

/** Rows a sheet may hold. Twelve is already four screens of dashboard. */
export const MAX_ROWS = 12;
const CHARTS_PER_ROW = 2;
/** A spotlight's rail. One KPI beside a chart six rows tall is a hole with a
 *  number in it; four would be tiles too short to read. */
const RAIL_MIN = 2;
const RAIL_MAX = 3;

/**
 * THE ONE SHAPING RULE. A row's type says how its items sit together; whatever
 * the type has no slot for follows in plain rows of its own — metrics as a
 * `kpis` row, visuals as `charts` rows of two, texts as `note` rows. So nothing
 * that validated is lost to a row that could not hold it, and each degenerate
 * case is this rule rather than a case of its own:
 *
 *   charts with five visuals            → charts, charts, charts
 *   spotlight whose visual was dropped  → kpis
 *   spotlight with one metric           → kpis, charts
 *   spotlight with five metrics         → spotlight (three in the rail), kpis
 *   annotated without its visual        → note
 *   annotated without its text          → charts
 *   any row with nothing left in it     → nothing
 *
 * Each kind keeps its order, so shaping never changes what the rows flatten to.
 */
function shape(type: unknown, items: RowItems): PlanRow[] {
  let { metrics, visuals, texts } = items;
  const out: PlanRow[] = [];
  if (type === 'spotlight' && visuals.length && metrics.length >= RAIL_MIN) {
    out.push({ type, visual: visuals[0], metrics: metrics.slice(0, RAIL_MAX) });
    visuals = visuals.slice(1);
    metrics = metrics.slice(RAIL_MAX);
  } else if (type === 'annotated' && visuals.length && texts.length) {
    out.push({ type, visual: visuals[0], text: texts[0] });
    visuals = visuals.slice(1);
    texts = texts.slice(1);
  }
  if (metrics.length) out.push({ type: 'kpis', metrics });
  for (let i = 0; i < visuals.length; i += CHARTS_PER_ROW) {
    out.push({ type: 'charts', visuals: visuals.slice(i, i + CHARTS_PER_ROW) });
  }
  for (const text of texts) out.push({ type: 'note', text });
  return out;
}

/** A row's items, whatever its type. Read LOOSELY: a row built in code, or one
 *  that came back from JSON, may be short a slot, and that must not throw. */
function itemsOf(row: PlanRow | null | undefined): RowItems {
  const r = (row || {}) as { metrics?: unknown; visuals?: unknown; visual?: PlannedVisual; text?: PlannedText };
  return {
    metrics: Array.isArray(r.metrics) ? r.metrics : [],
    visuals: Array.isArray(r.visuals) ? r.visuals : r.visual ? [r.visual] : [],
    texts: r.text ? [r.text] : [],
  };
}

/**
 * Rows put back into shape — the same rule validateRows applies, for rows that
 * are already typed. Three callers: planLayout.arrangeSheet, which places only
 * well-formed rows and so shapes whatever it is handed first; planBuild.ts,
 * which passes `keepVisual` to take out a chart whose save failed and let the
 * row it was in re-form around what is left; and presetRows below, which writes
 * the rows a named arrangement means and leaves fitting them to this.
 */
export function shapeRows(rows: readonly PlanRow[] | undefined, keepVisual?: (v: PlannedVisual) => boolean): PlanRow[] {
  const list: readonly PlanRow[] = Array.isArray(rows) ? rows : [];
  return list.flatMap((row) => {
    const items = itemsOf(row);
    return shape(row && row.type, keepVisual ? { ...items, visuals: items.visuals.filter(keepVisual) } : items);
  });
}

/** The arrangements a plan written in CODE asks for by name — the starter
 *  layouts and the templates. A model writes its own rows. */
export type RowPreset = 'spotlight' | 'lead';

/**
 * A sheet's flat lists as the rows of a named arrangement:
 *
 *   spotlight   the first chart with the KPIs in the rail beside it
 *   lead        the first chart at full width, then the KPI strip
 *
 * and after either, the remaining charts and then the notes. Each kind keeps its
 * order, so the lists handed in ARE the flattening of what comes back.
 *
 * It only says which row each tile is MEANT for. `shapeRows` decides what a row
 * can hold — one KPI is no rail, a fourth spills onto a strip, charts go two to
 * a row — so a short sheet needs no case here: with no chart there is only the
 * strip, and with nothing at all there are no rows and the sheet stays flat.
 */
export function presetRows(preset: RowPreset, items: RowItems): PlanRow[] {
  const { metrics, texts } = items;
  const [first, ...rest] = items.visuals;
  const strip: PlanRow = { type: 'kpis', metrics };
  const head: PlanRow[] = !first
    ? [strip]
    : preset === 'spotlight'
      ? [{ type: 'spotlight', visual: first, metrics }]
      : [{ type: 'charts', visuals: [first] }, strip];
  return shapeRows([...head, { type: 'charts', visuals: rest }, ...texts.map((text): PlanRow => ({ type: 'note', text }))]);
}

/** A stack of rows as a sheet's flat arrays: each kind in row order, and the
 *  SAME objects — which is how `metrics` / `visuals` / `texts` stay true for
 *  every reader that knows nothing about rows. */
export function flattenRows(rows: readonly PlanRow[]): RowItems {
  const flat: RowItems = { metrics: [], visuals: [], texts: [] };
  for (const row of rows) {
    const items = itemsOf(row);
    flat.metrics.push(...items.metrics);
    flat.visuals.push(...items.visuals);
    flat.texts.push(...items.texts);
  }
  return flat;
}

/** One item or a list of them, as a list. A model told `"visuals":[…]` for one
 *  row and `"visual":…` for the next mixes them up, and that is not worth a tile. */
function many(v: unknown): unknown[] {
  return Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
}

/**
 * A raw sheet's `rows`, validated. Same discipline as the rest of the plan:
 * every item goes through its own validator, what is off-list is DROPPED and
 * REPORTED, and what survives is shaped by the one rule above.
 *
 * Returns [] when there is nothing to arrange — no `rows` key, or none that
 * survived — and the caller then reads the sheet's flat arrays as it always has.
 *
 * `where` is the envelope path of the list (`sheets[0].rows`) and `at` the
 * sheet in words (`Sheet "Overview"`), as for the other validators.
 */
export function validateRows(
  rawRows: unknown,
  validate: RowValidators,
  dropped: PlanDrop[],
  where: string,
  at: string,
): PlanRow[] {
  const out: PlanRow[] = [];
  (Array.isArray(rawRows) ? rawRows : []).forEach((raw: unknown, ri) => {
    const rowWhere = `${where}[${ri}]`;
    const rowAt = `${at} row ${ri + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      dropped.push({ kind: 'row', where: rowWhere, message: `${rowAt} dropped: not an object.` });
      return;
    }
    const o = raw as Record<string, unknown>;
    const type = typeof o.type === 'string' ? o.type.trim() : '';
    if (!(ROW_TYPES as readonly string[]).includes(type)) {
      dropped.push({
        kind: 'row',
        where: rowWhere,
        message: `${rowAt} dropped: ${JSON.stringify(type)} is not one of Ordinate's row types (${ROW_TYPES.join(', ')}).`,
      });
      return;
    }
    const before = dropped.length;
    /** Every item under `keys` (the first one present), each through `fn`. */
    const read = <T>(keys: [string, string], noun: string, fn: (item: unknown, w: string, a: string) => T | null): T[] => {
      const key = o[keys[0]] !== undefined ? keys[0] : keys[1];
      const kept: T[] = [];
      many(o[key]).forEach((item, i) => {
        const hit = fn(item, Array.isArray(o[key]) ? `${rowWhere}.${key}[${i}]` : `${rowWhere}.${key}`, `${rowAt} ${noun} ${i + 1}`);
        if (hit) kept.push(hit);
      });
      return kept;
    };
    const visuals = read(['visuals', 'visual'], 'visual', validate.visual);
    const metrics = read(['metrics', 'metric'], 'metric', validate.metric);
    // A note written flat — { "type":"note", "heading":…, "text":"…" } — is the
    // row itself. It is what a model writes the moment it stops copying the
    // shape, and validateText reads exactly those two keys.
    let texts: PlannedText[];
    if (typeof o.text === 'string' || typeof o.heading === 'string') {
      const note = validate.text(o, rowWhere, `${rowAt} note`);
      texts = note ? [note] : [];
    } else {
      texts = read(['text', 'texts'], 'note', validate.text);
    }

    const rows = shape(type, { metrics, visuals, texts });
    // An item that failed has said why. A row that held nothing to begin with
    // has not, and a row that vanishes without a word is the one thing this
    // validator never does.
    if (!rows.length && dropped.length === before) {
      dropped.push({ kind: 'row', where: rowWhere, message: `${rowAt} dropped: a ${type} row with nothing in it.` });
    }
    out.push(...rows);
  });
  // Counted on the rows that come OUT. A split makes more rows than were
  // written, and a cap on the input would let validatePlan return a plan it
  // then trims on the way back from the browser.
  if (out.length > MAX_ROWS) {
    const extra = out.length - MAX_ROWS;
    dropped.push({
      kind: 'row',
      where,
      message: `${at}: the last ${extra === 1 ? 'row' : `${extra} rows`} dropped — a sheet holds at most ${MAX_ROWS} rows.`,
    });
    out.length = MAX_ROWS;
  }
  return out;
}

// ── The prompt that describes this vocabulary ──────────────────────────────
//
// Here, beside validateRows, for the reason analysisPlan.ts gives for keeping
// DRAFT_DASHBOARD_SYSTEM_PROMPT beside validatePlan: a prompt that drifts from
// its parser is an unseeable bug. scripts/test-planRows.ts fails if a row type
// is added above and not described below.
//
// It says what each row is FOR, not only what it holds. Told only the shapes, a
// model stacks a KPI strip on two rows of charts every time — the one layout
// the old packer drew — so the guidance is what makes the vocabulary worth
// having. The chart-variety clause is here for the same reason: it is advice on
// composing a sheet, and a sheet of five bar charts is the same sameness.
export const ROWS_PROMPT =
  'A sheet is a stack of ROWS, read top to bottom. Each <row> is ONE of:\n' +
  '  { "type":"charts", "visuals":[ <visual> ] }   one chart at full width — list two to set them side by side\n' +
  '  { "type":"spotlight", "visual":<visual>, "metrics":[ <kpi>, <kpi> ] }   one wide chart with two or three ' +
  'KPIs stacked beside it\n' +
  '  { "type":"annotated", "visual":<visual>, "text":<note> }   one wide chart with a note beside it\n' +
  '  { "type":"kpis", "metrics":[ <kpi>, ... ] }   a strip of KPI tiles, four to a line\n' +
  '  { "type":"note", "text":<note> }   a full-width note\n' +
  'where <note> is {"heading":"<short>","text":"<1-2 sentences, NO numbers>"}.\n' +
  'Choose the rows for what the sheet has to say, and do not give every sheet the same stack: open on a ' +
  'full-width "charts" row for a trend or a comparison; use "spotlight" for the one headline story, with the ' +
  'KPIs that explain it beside the chart; use "annotated" when a chart needs a sentence of explanation; use a ' +
  '"kpis" row only when a figure is a headline on its own — many sheets need none.\n' +
  'Fit each chart to its question: a donut for a share of a whole with few categories; a bullet or a gauge for ' +
  'a figure against a target; a bar for a ranking; a line or an area for a change over time; a table for ' +
  'detail. Do not repeat one chart type down a sheet without a reason.\n';
