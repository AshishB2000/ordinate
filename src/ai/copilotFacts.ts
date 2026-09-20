// The CONTEXT-FACT BUILDERS — MAIN PROCESS, and PURE: no fs, no DOM, no model.
//
// Each one FORMATS already-app-computed numbers (datasetStats / metricValue /
// vizData outputs) into a compact FACTS text block, a provenance descriptor and
// a number LEDGER. No builder ever derives a figure — it only lays out the ones
// handed to it. That is the analyze→compute→display contract: the app does the
// math, the model narrates it.
//
// Split out of copilot.ts under the 800-line cap (.claude/rules/file-size.md).
// copilot.ts said for a long time that it had "two responsibilities in one
// small module"; the module stopped being small, so the second one moved here.
// That file re-exports every name below, so `copilot.datasetFacts(...)` and
// friends keep working for ipc/copilot.ts and the self-checks unchanged.

import type { Dataset } from '../data/datasets';
import type { ColumnSummary, QualityIssue } from '../data/datasetStats';
import type { Visual } from '../analysis/visuals';
import type { Page } from '../analysis/dashboards';
import type { Analysis, AnalysisTile } from '../analysis/analysis';
import type { VizDataResult } from '../analysis/vizData';
import { harvestAppNumbers } from './numberAudit';
import type { LedgerEntry, LedgerUnit } from './numberAudit';
import type { CopilotFacts } from './copilot';

// ── Context facts (PURE — no fs/DOM/model) ──────────────────────────────────────
//
// Each builder FORMATS already-app-computed numbers into a compact FACTS text +
// provenance. Every text opens with the guard line stating the numbers are
// app-computed and must not be recomputed. No builder ever derives a figure — it
// only lays out the ones handed to it.

const GUARD_LINE =
  'The numbers below were computed by the app (Ordinate), not by you. ' +
  'Treat them as ground truth: cite them exactly and NEVER recompute, round, or invent a figure.';

const SAMPLE_ROWS = 5;

// Format one app-computed value for a facts line. null/undefined → "n/a" (so the
// model is told a figure is unavailable rather than being tempted to guess).
function fmt(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(v) : 'n/a';
}

// ── Ledger assembly ──────────────────────────────────────────────────────────
//
// One entry per figure the block hands the model. `n/a` adds nothing: a figure
// the app could not compute is precisely one the model may not state.

function num(
  ledger: LedgerEntry[],
  label: string,
  value: number | null | undefined,
  unit: LedgerUnit,
  source: string,
): void {
  if (typeof value === 'number' && Number.isFinite(value)) ledger.push({ label, value, unit, source });
}

// Figures inside a finished APP-AUTHORED sentence — a quality finding, a
// rendered sample row — where no structured field holds them separately. Never
// called on model output (see harvestAppNumbers).
function fromAppText(ledger: LedgerEntry[], label: string, appText: string, source: string): void {
  for (const h of harvestAppNumbers(appText)) ledger.push({ label, value: h.value, unit: h.unit, source });
}

/**
 * Last pass: enter anything the assembled text prints that the structured
 * entries above did not already cover.
 *
 * This is not a shortcut around building a real ledger — it is the guarantee
 * that the record can never be a subset of the prompt. Entity NAMES are the live
 * case: a dataset called "Q3 2024 orders" or a metric card labelled "Top 10
 * accounts" puts digits into the facts block that no statistic produced, and
 * without this a model repeating the name it was given would be accused of
 * inventing a figure. Erring toward silence is the rule here (./numberAudit).
 *
 * Returns how many entries it had to add. `scripts/test-numberAudit.ts` asserts
 * that is ZERO for fixtures whose names carry no digits — so the structured
 * entries stay the real ledger and this stays a backstop, rather than quietly
 * becoming the implementation.
 */
function sealLedger(ledger: LedgerEntry[], text: string, source: string): number {
  const before = ledger.length;
  for (const h of harvestAppNumbers(text)) {
    const covered = ledger.some((e) => Object.is(e.value, h.value) && (h.unit !== 'percent' || e.unit === 'percent'));
    if (!covered) ledger.push({ label: 'figure printed in the facts block', value: h.value, unit: h.unit, source });
  }
  return ledger.length - before;
}

// Dataset: columns + types + app-computed stats (min/max/mean/count |
// distinct/mostCommon) + quality issues + up to N sample rows. This is the
// generalized twin of ipc/datasets.buildDatasetSummaryText (same shape) with the
// guard line prepended.
export function datasetFacts(
  ds: Dataset,
  summaries: ColumnSummary[],
  issues: QualityIssue[],
  // What the app FOUND (src/analysis/insights.ts), so "why did West drop?" has
  // the app's own figures to narrate instead of the model deriving one. Each
  // arrives as a finished, app-authored sentence; `sealLedger` below harvests
  // its numbers exactly as it already does for the quality notes, so the
  // fidelity guard covers these figures like any other.
  insights: { detail: string }[] = [],
): CopilotFacts {
  const lines: string[] = [GUARD_LINE, ''];
  const ledger: LedgerEntry[] = [];
  const SRC = 'datasetStats';
  lines.push(`Dataset: "${ds.name}" (${ds.rowCount} rows, ${ds.columns.length} columns).`);
  num(ledger, 'row count', ds.rowCount, 'count', 'dataset');
  num(ledger, 'column count', ds.columns.length, 'count', 'dataset');
  lines.push('');
  lines.push('Columns and computed statistics:');
  summaries.forEach((s) => {
    if (s.type === 'number') {
      const parts: string[] = [];
      if (typeof s.min === 'number') parts.push(`min ${s.min}`);
      if (typeof s.max === 'number') parts.push(`max ${s.max}`);
      if (typeof s.mean === 'number') parts.push(`mean ${s.mean}`);
      parts.push(`${s.count ?? 0} numeric values`, `${s.nonEmpty} non-empty`);
      lines.push(`- ${s.name} (number): ${parts.join(', ')}`);
      num(ledger, `${s.name} min`, s.min, 'number', SRC);
      num(ledger, `${s.name} max`, s.max, 'number', SRC);
      num(ledger, `${s.name} mean`, s.mean, 'number', SRC);
      num(ledger, `${s.name} numeric values`, s.count ?? 0, 'count', SRC);
      num(ledger, `${s.name} non-empty`, s.nonEmpty, 'count', SRC);
    } else {
      const parts: string[] = [`${s.distinct ?? 0} distinct`, `${s.nonEmpty} non-empty`];
      if (s.mostCommon) parts.push(`most common "${s.mostCommon.value}" (${s.mostCommon.count}x)`);
      lines.push(`- ${s.name} (${s.type}): ${parts.join(', ')}`);
      num(ledger, `${s.name} distinct`, s.distinct ?? 0, 'count', SRC);
      num(ledger, `${s.name} non-empty`, s.nonEmpty, 'count', SRC);
      if (s.mostCommon) num(ledger, `${s.name} most common count`, s.mostCommon.count, 'count', SRC);
    }
  });
  if (issues.length > 0) {
    lines.push('');
    lines.push('Data-quality notes:');
    // A finding arrives as a finished sentence ('Column "region" is 60% empty'),
    // so its figures — the app's ONLY source of percentages — are harvested from
    // the sentence rather than read off fields that do not exist.
    issues.forEach((i) => {
      lines.push(`- ${i.detail}`);
      fromAppText(ledger, `quality: ${i.kind}`, i.detail, 'datasetStats.quality');
    });
  }
  if (insights.length > 0) {
    lines.push('');
    lines.push('What the app found (every figure below is app-computed):');
    insights.forEach((i) => lines.push(`- ${i.detail}`));
  }
  const sample = ds.rows.slice(0, SAMPLE_ROWS);
  if (sample.length > 0) {
    lines.push('');
    lines.push(`Sample rows (first ${sample.length}):`);
    num(ledger, 'sample rows shown', sample.length, 'count', 'dataset.sample');
    lines.push(ds.columns.map((c) => c.name).join(' | '));
    sample.forEach((row) => {
      // Harvested from the RENDERED line, not the cells: a text column stores
      // '007' and prints '007', and what the model can cite is what it was shown.
      const rendered = ds.columns.map((_, c) => (row && row[c] != null ? String(row[c]) : '')).join(' | ');
      lines.push(rendered);
      fromAppText(ledger, 'sample row cell', rendered, 'dataset.sample');
    });
  }
  const text = lines.join('\n');
  sealLedger(ledger, text, 'dataset');
  return {
    text,
    ledger,
    provenance: {
      kind: 'dataset',
      name: ds.name,
      columns: summaries.map((s) => s.name),
      note: 'stats app-computed',
    },
  };
}

// Visual: chart type + encoding (category, measures+aggregations, optional series)
// + the COMPUTED labels/series from vizData.buildVizData (real, app-computed
// numbers). No figure is derived here — viz already did the math.
export function visualFacts(v: Visual, datasetName: string, viz: VizDataResult): CopilotFacts {
  const lines: string[] = [GUARD_LINE, ''];
  lines.push(`Visual: "${v.name}" — a ${v.chartType} chart over dataset "${datasetName}".`);
  const measures = (v.encoding.values || [])
    .map((m) => `${m.aggregation}(${m.column})`)
    .join(', ');
  lines.push(`Category (x): ${v.encoding.category}. Measures: ${measures || '(none)'}` +
    (v.encoding.series ? `. Split by: ${v.encoding.series}.` : '.'));

  const ledger: LedgerEntry[] = [];
  const data = viz && viz.data ? viz.data : { labels: [], series: [] };
  const labels = Array.isArray(data.labels) ? data.labels : [];
  const series = Array.isArray(data.series) ? data.series : [];
  if (labels.length > 0 && series.length > 0) {
    lines.push('');
    lines.push('Computed chart values (app-computed):');
    series.forEach((s) => {
      const pairs = labels
        .map((lab, i) => `${lab}=${fmt(s.values ? s.values[i] : null)}`)
        .join(', ');
      lines.push(`- ${s.name}: ${pairs}`);
      // One entry per MARK, labelled the way the chart labels it, so a violation
      // report names the bar the model was looking at.
      labels.forEach((lab, i) => num(ledger, `${s.name} @ ${lab}`, s.values ? s.values[i] : null, 'number', 'vizData'));
    });
  } else {
    lines.push('');
    lines.push('This visual produced no plottable values.');
  }
  const text = lines.join('\n');
  sealLedger(ledger, text, 'visual');
  return {
    text,
    ledger,
    provenance: {
      kind: 'visual',
      name: v.name,
      datasetName,
      columns: [v.encoding.category, ...(v.encoding.values || []).map((m) => m.column)],
      note: 'stats app-computed',
    },
  };
}

// The card body for analysisFacts: metric cards (each a single app-computed
// number) then the text-card inventory. Kept as its own function so the layout
// the grounding prompt expects lives in one place.
function cardBodyLines(
  pages: Page[] | undefined,
  computed: { label: string; value: number | null }[],
  ledger: LedgerEntry[],
): string[] {
  const lines: string[] = [];
  if (computed.length > 0) {
    lines.push('');
    lines.push('Metric cards (each a single app-computed number):');
    computed.forEach((m) => {
      lines.push(`- ${m.label}: ${fmt(m.value)}`);
      num(ledger, m.label, m.value, 'number', 'metricValue');
    });
  }
  const otherCards: string[] = [];
  (pages || []).forEach((p) =>
    (p.cards || []).forEach((c) => {
      if (c.type === 'text' && c.heading) otherCards.push(`text card "${c.heading}"`);
    }),
  );
  if (otherCards.length > 0) {
    lines.push('');
    lines.push('Other cards: ' + otherCards.join(', ') + '.');
  }
  return lines;
}

function countCards(pages: Page[] | undefined): number {
  return (pages || []).reduce((n, p) => n + (Array.isArray(p.cards) ? p.cards.length : 0), 0);
}

// Dashboard facts (internally an Analysis record): the sheet roster plus each
// metric card's ONE app-computed number, for the model to narrate. The provenance
// kind stays 'analysis' — the internal record type — while the prose says Dashboard.
export function analysisFacts(
  a: Analysis,
  computed: { label: string; value: number | null }[],
  tiles: AnalysisTile[] = [],
): CopilotFacts {
  const sheets = Array.isArray(a.sheets) ? a.sheets : [];
  const lines: string[] = [GUARD_LINE, ''];
  const ledger: LedgerEntry[] = [];
  lines.push(
    `Dashboard: "${a.name}" ` +
    `(${sheets.length} sheet(s), ${countCards(sheets)} card(s)).`,
  );
  num(ledger, 'sheet count', sheets.length, 'count', 'dashboard');
  num(ledger, 'card count', countCards(sheets), 'count', 'dashboard');
  // Per-sheet roster, ADDITIVE to the shared body below — "what's on sheet 2" is
  // unanswerable from a flat card list, and a dashboard is authored sheet by sheet.
  if (sheets.length === 0) {
    lines.push('Sheets: (none).');
  } else {
    lines.push('Sheets:');
    sheets.forEach((s, i) => {
      const cards = Array.isArray(s.cards) ? s.cards : [];
      const counts = new Map<string, number>();
      cards.forEach((c) => counts.set(c.type, (counts.get(c.type) || 0) + 1));
      const breakdown = Array.from(counts.entries()).map(([t, n]) => `${n} ${t}`).join(', ');
      lines.push(`- Sheet ${i + 1} "${s.name}": ${cards.length} card(s)${breakdown ? ` (${breakdown})` : ''}.`);
      num(ledger, `sheet ${i + 1} ("${s.name}") card count`, cards.length, 'count', 'dashboard');
      counts.forEach((n, t) => num(ledger, `sheet ${i + 1} ${t} cards`, n, 'count', 'dashboard'));
      // Each tile BY NAME, which is the whole point: a model that can only see
      // "2 visual" can describe this dashboard but cannot ask to change one of
      // them. Titles are what an edit delta names, and what the app resolves
      // back to a card id — so what is listed here bounds what can be edited.
      // Column and aggregation NAMES only; no values, no figures.
      tiles.filter((t) => t.pageIndex === i).forEach((t) => {
        const bits: string[] = [];
        if (t.chartType) bits.push(t.chartType);
        if (t.category) bits.push(`by ${t.category}`);
        if (t.measures && t.measures.length) bits.push(t.measures.join(', '));
        lines.push(`  - "${t.title}" (${t.type}${bits.length ? ': ' + bits.join(' · ') : ''})`);
      });
    });
  }
  lines.push(...cardBodyLines(sheets, computed, ledger));
  const text = lines.join('\n');
  sealLedger(ledger, text, 'dashboard');
  return {
    text,
    ledger,
    provenance: {
      kind: 'analysis',
      name: a.name,
      columns: computed.map((m) => m.label),
      note: 'stats app-computed',
    },
  };
}

/**
 * Capture: what the model READ off a screenshot, plus what the app computed
 * over it.
 *
 * The split matters and is stated in the block itself. The table is an
 * EXTRACTION — a model read it off an image and it can be wrong, which is why
 * the app asks the user to review it before it becomes a dataset. Every
 * statistic below it is the app's own (`computeColumnSummary`, the same
 * function the dataset path uses), so the ledger covers these figures exactly
 * as it covers a saved dataset's.
 */
export function captureFacts(
  title: string,
  columns: { name: string; type: string }[],
  summaries: ColumnSummary[],
  rows: unknown[][],
): CopilotFacts {
  const lines: string[] = [GUARD_LINE, ''];
  const ledger: LedgerEntry[] = [];
  const SRC = 'captureStats';
  lines.push(`Screenshot capture: "${title}".`);
  lines.push('The table below was EXTRACTED from an image by a model and may contain '
    + 'mis-read values; the statistics under it were computed by the app from that table.');
  lines.push(`Extracted table: ${rows.length} rows, ${columns.length} columns.`);
  num(ledger, 'row count', rows.length, 'count', 'capture');
  num(ledger, 'column count', columns.length, 'count', 'capture');
  if (summaries.length > 0) {
    lines.push('');
    lines.push('Columns and computed statistics:');
    summaries.forEach((s) => {
      if (s.type === 'number') {
        lines.push(`- ${s.name} (number): min ${fmt(s.min)}, max ${fmt(s.max)}, mean ${fmt(s.mean)}, `
          + `${s.count ?? 0} numeric values, ${s.nonEmpty} non-empty`);
        num(ledger, `${s.name} min`, s.min, 'number', SRC);
        num(ledger, `${s.name} max`, s.max, 'number', SRC);
        num(ledger, `${s.name} mean`, s.mean, 'number', SRC);
        num(ledger, `${s.name} numeric values`, s.count ?? 0, 'count', SRC);
        num(ledger, `${s.name} non-empty`, s.nonEmpty, 'count', SRC);
      } else {
        const parts = [`${s.distinct ?? 0} distinct`, `${s.nonEmpty} non-empty`];
        if (s.mostCommon) parts.push(`most common "${s.mostCommon.value}" (${s.mostCommon.count}x)`);
        lines.push(`- ${s.name} (${s.type}): ${parts.join(', ')}`);
        num(ledger, `${s.name} distinct`, s.distinct ?? 0, 'count', SRC);
        num(ledger, `${s.name} non-empty`, s.nonEmpty, 'count', SRC);
        if (s.mostCommon) num(ledger, `${s.name} most common count`, s.mostCommon.count, 'count', SRC);
      }
    });
  }
  const sample = rows.slice(0, SAMPLE_ROWS);
  if (sample.length > 0) {
    lines.push('');
    lines.push(`Sample rows (first ${sample.length}):`);
    num(ledger, 'sample rows shown', sample.length, 'count', 'capture.sample');
    lines.push(columns.map((c) => c.name).join(' | '));
    sample.forEach((row) => {
      // Harvested from the RENDERED line, exactly as datasetFacts does: what the
      // model may cite is what it was shown, '007' included.
      const rendered = columns.map((_, c) => (row && row[c] != null ? String(row[c]) : '')).join(' | ');
      lines.push(rendered);
      fromAppText(ledger, 'sample row cell', rendered, 'capture.sample');
    });
  }
  const text = lines.join('\n');
  sealLedger(ledger, text, 'capture');
  return {
    text,
    ledger,
    provenance: {
      kind: 'capture',
      name: title,
      columns: columns.map((c) => c.name),
      note: 'stats app-computed',
    },
  };
}

// Project fallback when nothing specific is open: names of the project's datasets,
// visuals, and dashboards (the analysis records; no numbers to compute — pure inventory).
export function projectFacts(
  name: string,
  inventory: { datasets: string[]; visuals: string[]; dashboards: string[] },
): CopilotFacts {
  const lines: string[] = [GUARD_LINE, ''];
  const ledger: LedgerEntry[] = [];
  lines.push(`Project: "${name}".`);
  lines.push(`Datasets (${inventory.datasets.length}): ${inventory.datasets.join(', ') || '(none)'}.`);
  lines.push(`Visuals (${inventory.visuals.length}): ${inventory.visuals.join(', ') || '(none)'}.`);
  lines.push(`Dashboards (${inventory.dashboards.length}): ${inventory.dashboards.join(', ') || '(none)'}.`);
  num(ledger, 'dataset count', inventory.datasets.length, 'count', 'project');
  num(ledger, 'visual count', inventory.visuals.length, 'count', 'project');
  num(ledger, 'dashboard count', inventory.dashboards.length, 'count', 'project');
  lines.push('');
  lines.push('No specific dataset/visual/dashboard is open, so no per-entity figures are available. ' +
    'Ask the user to open one for numeric detail.');
  const text = lines.join('\n');
  // Entity NAMES are the only other digits here, and a model is entitled to
  // repeat the inventory it was handed.
  sealLedger(ledger, text, 'project');
  return {
    text,
    ledger,
    provenance: { kind: 'project', name, note: 'stats app-computed' },
  };
}
