// Per-project AI Copilot chat history + context-fact builder — MAIN PROCESS ONLY.
//
// Two responsibilities in one small module (ponytail — one thread per project,
// no fan-out):
//   1. PERSISTENCE — one chat thread per project, one JSON file:
//      userData/projects/<projectId>/copilot.json. Mirrors src/projects.ts /
//      src/datasets.ts verbatim: the UUID id-validation guard, atomic
//      temp-then-rename writes, graceful skip of missing/corrupt files, and a
//      normalize() that re-sanitizes untrusted-on-disk turns on load.
//   2. CONTEXT FACTS — PURE builders (no fs/DOM/model) that FORMAT already-
//      app-computed numbers (datasetStats / metricValue / vizData outputs) into a
//      compact FACTS text block + a provenance descriptor. The model only narrates
//      these figures; it NEVER computes or invents one — the analyze→compute→
//      display contract, generalized from ipc/datasets.buildDatasetSummaryText.
//
// DUAL-UUID note (honest read): only `projectId` is ever concatenated into a
// filesystem path, so only it needs the traversal guard (copied verbatim from
// projects.ts). Each turn still gets a generated randomUUID() `id` — a stable
// renderer key, NEVER a path component — so the "path id validated, record id
// generated" discipline is honored where it matters.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { app } from 'electron';
import * as projects from './projects';
import type { Dataset } from './datasets';
import type { ColumnSummary, QualityIssue } from './datasetStats';
import type { Visual } from './visuals';
import type { Dashboard } from './dashboards';
import type { VizDataResult } from './vizData';

// ── Types ─────────────────────────────────────────────────────────────────────

// Where the FACTS in an assistant turn came from — safe to show to the user as
// provenance chips. `note` is always 'stats app-computed' (the app did the math).
export interface CopilotProvenance {
  kind: 'dataset' | 'visual' | 'dashboard' | 'project';
  name: string;            // entity name (safe to show)
  datasetName?: string;    // for visual/dashboard cards, the underlying dataset
  columns?: string[];      // columns whose stats were sent
  note: string;            // e.g. 'stats app-computed'
}

export interface CopilotTurn {
  id: string;                        // randomUUID — a stable key only, never a path
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;                 // ISO timestamp
  provenance?: CopilotProvenance;    // assistant turns only
}

interface CopilotThread {
  projectId: string;
  turns: CopilotTurn[];
  schemaVersion: 1;
}

// A new turn as handed in by the caller (id + createdAt are assigned on append).
export interface NewCopilotTurn {
  role: 'user' | 'assistant';
  text: string;
  provenance?: CopilotProvenance;
}

// A compact FACTS block + its provenance — what a context builder returns.
export interface CopilotFacts {
  text: string;
  provenance: CopilotProvenance;
}

// Ring-cap so a project's chat file can't grow unbounded.
const MAX_TURNS = 200;

// ── Persistence ────────────────────────────────────────────────────────────────

let projectsBase: string | null = null;
function getProjectsBase(): string {
  if (!projectsBase) projectsBase = path.join(app.getPath('userData'), 'projects');
  return projectsBase;
}

// projectId arrives from the renderer over IPC. Validate the SHAPE before it ever
// reaches a filesystem path — an id like ".." or "../../foo" would otherwise escape
// userData/projects. Copied verbatim from projects.ts / datasets.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

function copilotFilePath(projectId: string): string {
  return path.join(getProjectsBase(), projectId, 'copilot.json');
}

// Atomic JSON write: temp sibling then rename (atomic on same fs). Copied verbatim.
async function writeJsonAtomic(file: string, obj: unknown): Promise<void> {
  // Unique tmp per write: a fixed name lets two overlapping writes to the same
  // record share one temp path and interleave into a corrupt file (or ENOENT on
  // the second rename). A per-write suffix degrades the race to clean last-writer-wins.
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.promises.rename(tmp, file); // atomic on same fs
}

const ROLES: ReadonlySet<string> = new Set(['user', 'assistant']);
const PROV_KINDS: ReadonlySet<string> = new Set(['dataset', 'visual', 'dashboard', 'project']);

// Re-sanitize an untrusted stored provenance object (whitelist fields only).
function normalizeProvenance(p: any): CopilotProvenance | undefined {
  if (!p || typeof p !== 'object') return undefined;
  const kind = PROV_KINDS.has(p.kind) ? p.kind : 'project';
  const prov: CopilotProvenance = {
    kind,
    name: typeof p.name === 'string' ? p.name : '',
    note: typeof p.note === 'string' ? p.note : 'stats app-computed',
  };
  if (typeof p.datasetName === 'string') prov.datasetName = p.datasetName;
  if (Array.isArray(p.columns)) prov.columns = p.columns.filter((c: any) => typeof c === 'string');
  return prov;
}

// Re-sanitize the whole stored thread on load (drop non-object turns, clamp role,
// coerce text to string, keep/repair id + createdAt, whitelist provenance).
function normalize(data: any): CopilotTurn[] {
  const raw = data && Array.isArray(data.turns) ? data.turns : [];
  const turns: CopilotTurn[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const role: 'user' | 'assistant' = ROLES.has(t.role) ? t.role : 'user';
    const turn: CopilotTurn = {
      id: typeof t.id === 'string' && t.id ? t.id : randomUUID(),
      role,
      text: typeof t.text === 'string' ? t.text : String(t.text ?? ''),
      createdAt: typeof t.createdAt === 'string' && t.createdAt ? t.createdAt : new Date().toISOString(),
    };
    const prov = normalizeProvenance(t.provenance);
    if (prov) turn.provenance = prov;
    turns.push(turn);
  }
  // Defensive cap on load too, in case a file predates a lower MAX_TURNS.
  return turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns;
}

// No-op stub kept for symmetry with projects.init()/datasets.init() — the file is
// created lazily on first appendTurn (its parent project dir already exists).
export async function init(): Promise<void> {
  // Intentionally empty.
}

// Load a project's chat history in order. Invalid id, missing file, or corrupt
// JSON all yield [] (the "no history yet" path) — never throws.
export async function loadHistory(projectId: string): Promise<CopilotTurn[]> {
  if (!isValidId(projectId)) return [];
  try {
    const rawText = await fs.promises.readFile(copilotFilePath(projectId), 'utf8');
    return normalize(JSON.parse(rawText));
  } catch (err: any) { // ponytail: fs errors carry .code, JSON errors don't
    if (err && err.code !== 'ENOENT') {
      console.error('[copilot] Skipping corrupt or unreadable copilot.json:', projectId, err.message);
    }
    return [];
  }
}

// Append ONE turn (assigning its id + createdAt), cap to the last MAX_TURNS, and
// atomic-write. Returns the full updated list, or null if the projectId is invalid
// or its parent project no longer exists (no orphan chat under a bogus id).
export async function appendTurn(projectId: string, turn: NewCopilotTurn): Promise<CopilotTurn[] | null> {
  if (!isValidId(projectId)) return null;
  const parent = await projects.getProject(projectId);
  if (!parent) return null;

  const existing = await loadHistory(projectId);
  const role: 'user' | 'assistant' = turn && ROLES.has(turn.role) ? turn.role : 'user';
  const record: CopilotTurn = {
    id: randomUUID(),
    role,
    text: turn && typeof turn.text === 'string' ? turn.text : String((turn && turn.text) ?? ''),
    createdAt: new Date().toISOString(),
  };
  const prov = normalizeProvenance(turn && turn.provenance);
  if (prov) record.provenance = prov;

  const next = [...existing, record];
  const capped = next.length > MAX_TURNS ? next.slice(next.length - MAX_TURNS) : next;
  const thread: CopilotThread = { projectId, turns: capped, schemaVersion: 1 };

  await fs.promises.mkdir(path.join(getProjectsBase(), projectId), { recursive: true });
  await writeJsonAtomic(copilotFilePath(projectId), thread);
  return capped;
}

// Delete a project's copilot.json. Returns true on success — a missing file is
// success (force), an invalid id is false.
export async function clearHistory(projectId: string): Promise<boolean> {
  if (!isValidId(projectId)) return false;
  try {
    await fs.promises.rm(copilotFilePath(projectId), { force: true });
    return true;
  } catch (_) {
    return false;
  }
}

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

// Dataset: columns + types + app-computed stats (min/max/mean/count |
// distinct/mostCommon) + quality issues + up to N sample rows. This is the
// generalized twin of ipc/datasets.buildDatasetSummaryText (same shape) with the
// guard line prepended.
export function datasetFacts(ds: Dataset, summaries: ColumnSummary[], issues: QualityIssue[]): CopilotFacts {
  const lines: string[] = [GUARD_LINE, ''];
  lines.push(`Dataset: "${ds.name}" (${ds.rowCount} rows, ${ds.columns.length} columns).`);
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
    } else {
      const parts: string[] = [`${s.distinct ?? 0} distinct`, `${s.nonEmpty} non-empty`];
      if (s.mostCommon) parts.push(`most common "${s.mostCommon.value}" (${s.mostCommon.count}x)`);
      lines.push(`- ${s.name} (${s.type}): ${parts.join(', ')}`);
    }
  });
  if (issues.length > 0) {
    lines.push('');
    lines.push('Data-quality notes:');
    issues.forEach((i) => lines.push(`- ${i.detail}`));
  }
  const sample = ds.rows.slice(0, SAMPLE_ROWS);
  if (sample.length > 0) {
    lines.push('');
    lines.push(`Sample rows (first ${sample.length}):`);
    lines.push(ds.columns.map((c) => c.name).join(' | '));
    sample.forEach((row) => {
      lines.push(ds.columns.map((_, c) => (row && row[c] != null ? String(row[c]) : '')).join(' | '));
    });
  }
  return {
    text: lines.join('\n'),
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
    });
  } else {
    lines.push('');
    lines.push('This visual produced no plottable values.');
  }
  return {
    text: lines.join('\n'),
    provenance: {
      kind: 'visual',
      name: v.name,
      datasetName,
      columns: [v.encoding.category, ...(v.encoding.values || []).map((m) => m.column)],
      note: 'stats app-computed',
    },
  };
}

// Dashboard: page/card inventory + each metric card's ONE app-computed number
// (metricValue.computeMetric, passed in) + referenced visual names.
export function dashboardFacts(
  d: Dashboard,
  computed: { label: string; value: number | null }[],
): CopilotFacts {
  const pageCount = Array.isArray(d.pages) ? d.pages.length : 0;
  const cardCount = (d.pages || []).reduce((n, p) => n + (Array.isArray(p.cards) ? p.cards.length : 0), 0);
  const lines: string[] = [GUARD_LINE, ''];
  lines.push(`Dashboard: "${d.name}" (${pageCount} page(s), ${cardCount} card(s)).`);
  if (computed.length > 0) {
    lines.push('');
    lines.push('Metric cards (each a single app-computed number):');
    computed.forEach((m) => lines.push(`- ${m.label}: ${fmt(m.value)}`));
  }
  const visualNames: string[] = [];
  (d.pages || []).forEach((p) =>
    (p.cards || []).forEach((c) => {
      if (c.type === 'text' && c.heading) visualNames.push(`text card "${c.heading}"`);
    }),
  );
  if (visualNames.length > 0) {
    lines.push('');
    lines.push('Other cards: ' + visualNames.join(', ') + '.');
  }
  return {
    text: lines.join('\n'),
    provenance: {
      kind: 'dashboard',
      name: d.name,
      columns: computed.map((m) => m.label),
      note: 'stats app-computed',
    },
  };
}

// Project fallback when nothing specific is open: names of the project's datasets,
// visuals, and dashboards (no numbers to compute — pure inventory).
export function projectFacts(
  name: string,
  inventory: { datasets: string[]; visuals: string[]; dashboards: string[] },
): CopilotFacts {
  const lines: string[] = [GUARD_LINE, ''];
  lines.push(`Project: "${name}".`);
  lines.push(`Datasets (${inventory.datasets.length}): ${inventory.datasets.join(', ') || '(none)'}.`);
  lines.push(`Visuals (${inventory.visuals.length}): ${inventory.visuals.join(', ') || '(none)'}.`);
  lines.push(`Dashboards (${inventory.dashboards.length}): ${inventory.dashboards.join(', ') || '(none)'}.`);
  lines.push('');
  lines.push('No specific dataset/visual/dashboard is open, so no per-entity figures are available. ' +
    'Ask the user to open one for numeric detail.');
  return {
    text: lines.join('\n'),
    provenance: { kind: 'project', name, note: 'stats app-computed' },
  };
}
