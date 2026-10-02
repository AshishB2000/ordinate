// NOTEBOOKS — the record's shape and its whitelist. MAIN PROCESS, pure.
//
// A notebook is an ordered list of cells. Five kinds:
//
//   sql       DuckDB SQL over the project's datasets — and over the views of
//             the SQL cells above it (./graph.ts names them, ./run.ts inlines them)
//   formula   ONE expression in the app's formula language, evaluated over the
//             previous cell's result as a calculated column (src/formula — no eval)
//   chart     an ordinary Visuals builder spec (chartType + VizEncoding) over
//             any earlier SQL or formula cell, computed by vizData.buildVizData
//   markdown  the text-card subset (renderer/hub/markdown.ts)
//   param     a named, typed value later cells read as `[[name]]`
//
// `sanitizeCells` runs on every load AND every save, like storyModel's
// sanitizeBlocks: a hand-edited file cannot smuggle a cell kind, an oversized
// statement or a non-UUID id past it. Ids are kept when they are UUIDs and
// minted otherwise, so a cell keeps its id — and its saved datasets, its
// pinned visuals, its cached result — across every edit.

import { MAX_ORIGIN_SQL } from '../../data/datasetOrigin';
import { PARAM_NAME_RE } from '../params';
import { daysFromIso } from '../dateIntel';
import { sanitizeChartType, sanitizeEncoding } from '../visuals';
import type { VizEncoding } from '../visuals';

export type CellKind = 'sql' | 'formula' | 'chart' | 'markdown' | 'param';
export const CELL_KINDS: readonly CellKind[] = ['sql', 'formula', 'chart', 'markdown', 'param'];

/** A parameter cell's declared type — what its `[[name]]` binds as. */
export type NbParamType = 'number' | 'text' | 'date';
export const NB_PARAM_TYPES: readonly NbParamType[] = ['number', 'text', 'date'];

interface CellBase {
  id: string;
  /** Optional. A SQL cell's title is also its view name, slugged (./graph.ts). */
  title?: string;
}
export interface SqlCell extends CellBase { kind: 'sql'; sql: string }
export interface FormulaCell extends CellBase { kind: 'formula'; expression: string; column: string }
export interface ChartCell extends CellBase { kind: 'chart'; sourceCellId: string; chartType: string; encoding: VizEncoding }
export interface MarkdownCell extends CellBase { kind: 'markdown'; text: string }
export interface ParamCell extends CellBase { kind: 'param'; name: string; type: NbParamType; value: number | string | null }
export type NbCell = SqlCell | FormulaCell | ChartCell | MarkdownCell | ParamCell;

export interface Notebook {
  id: string;
  projectId: string;
  name: string;
  cells: NbCell[];
  createdAt: string;
  updatedAt: string;
  schemaVersion: 1;
}

export const MAX_CELLS = 200;
const MAX_TEXT = 20_000;
const MAX_EXPR = 2_000;
const MAX_TITLE = 120;
const MAX_PARAM_TEXT = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** A parameter value, shaped by its type. Anything that does not fit is null — "no value yet". */
export function sanitizeParamValue(type: NbParamType, raw: unknown): number | string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (type === 'number') {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    return Number.isFinite(n) && Math.abs(n) <= 1e15 ? n : null;
  }
  if (type === 'date') return typeof raw === 'string' && daysFromIso(raw.trim()) !== null ? raw.trim() : null;
  return typeof raw === 'string' || typeof raw === 'number' ? String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_PARAM_TEXT) : null;
}

function sanitizeCell(raw: unknown, newId: () => string, seen: Set<string>): NbCell | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind as CellKind;
  if (!CELL_KINDS.includes(kind)) return null;
  let id = typeof o.id === 'string' && UUID_RE.test(o.id) ? o.id.toLowerCase() : newId();
  if (seen.has(id)) id = newId(); // a duplicated cell must not share its original's results
  seen.add(id);
  const base: CellBase = { id };
  const title = str(o.title, MAX_TITLE).replace(/\s+/g, ' ').trim();
  if (title) base.title = title;
  switch (kind) {
    case 'sql':
      return { ...base, kind, sql: str(o.sql, MAX_ORIGIN_SQL) };
    case 'formula':
      return { ...base, kind, expression: str(o.expression, MAX_EXPR), column: str(o.column, MAX_TITLE).trim() || 'value' };
    case 'chart': {
      const src = typeof o.sourceCellId === 'string' && UUID_RE.test(o.sourceCellId) ? o.sourceCellId.toLowerCase() : '';
      return { ...base, kind, sourceCellId: src, chartType: sanitizeChartType(o.chartType), encoding: sanitizeEncoding(o.encoding) };
    }
    case 'markdown':
      return { ...base, kind, text: str(o.text, MAX_TEXT) };
    case 'param': {
      const type: NbParamType = NB_PARAM_TYPES.includes(o.type as NbParamType) ? (o.type as NbParamType) : 'text';
      const name = typeof o.name === 'string' && PARAM_NAME_RE.test(o.name.trim()) ? o.name.trim() : '';
      return { ...base, kind, name, type, value: sanitizeParamValue(type, o.value) };
    }
    default:
      return null;
  }
}

/** Untrusted cells → clean. Unknown kinds are dropped; the list is capped. Never throws. */
export function sanitizeCells(raw: unknown, newId: () => string): NbCell[] {
  const out: NbCell[] = [];
  const seen = new Set<string>();
  for (const r of Array.isArray(raw) ? raw : []) {
    const c = sanitizeCell(r, newId, seen);
    if (c) out.push(c);
    if (out.length >= MAX_CELLS) break;
  }
  return out;
}

/** The cells a new notebook opens on: a heading to write under, and a query to start from. */
export function starterCells(name: string, firstDatasetSlug: string | null, newId: () => string): NbCell[] {
  return [
    { id: newId(), kind: 'markdown', text: `# ${name}\nWhat question does this notebook answer? Write it here, then query below.` },
    { id: newId(), kind: 'sql', sql: firstDatasetSlug ? `select *\nfrom ${firstDatasetSlug}\nlimit 100` : '' },
  ];
}

/** The card excerpt: the first markdown line that is not a heading. */
export function excerptOf(cells: NbCell[]): string {
  for (const c of cells) {
    if (c.kind !== 'markdown') continue;
    for (const line of c.text.split('\n')) {
      const t = line.trim();
      if (t && !/^#{1,6}\s/.test(t)) return t.replace(/[*_`>]/g, '').replace(/^[-+] |^\d+\. /, '').slice(0, 160);
    }
  }
  return '';
}
