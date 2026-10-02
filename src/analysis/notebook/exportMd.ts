// NOTEBOOKS — the Markdown export. MAIN PROCESS, pure: cells and results in,
// one Markdown string out. scripts/test-notebooks.ts asserts the shape.
//
// Every cell in order: a markdown cell verbatim; a parameter as its binding; a
// SQL cell's statement in a ```sql fence, a formula as `[column] = expression`,
// each followed by its result as a Markdown table — at most MAX_ROWS rows, then
// "… N more rows" — and its row count and run time; a chart as an image.
//
// The images are EMBEDDED as data: URIs, so the export is one self-contained
// file — the reports' rule (a PDF, PPTX or DOCX carries its charts inside it).
// Only a PNG data URL is accepted; anything else is left out with a note.

import type { ParsedColumn } from '../../data/parse';
import type { Cell } from '../../data/transforms';
import type { NotebookGraph } from './graph';
import type { NbCell } from './model';

export const MAX_ROWS = 20;
const PNG_RE = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

export interface ExportResult {
  columns: ParsedColumn[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
  elapsedMs?: number;
}

export interface ExportInput {
  name: string;
  cells: NbCell[];
  graph: NotebookGraph;
  /** Results by cell id (SQL and formula cells). A missing one says so. */
  results: Record<string, ExportResult | { error: string }>;
  /** PNG data URLs by chart cell id, rendered by the page's own chart engine. */
  charts: Record<string, string>;
  exportedAt?: Date;
}

/** A cell for a Markdown table: pipes escaped, line breaks flattened, numbers as written. */
export function mdCell(v: Cell): string {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function mdTable(columns: ParsedColumn[], rows: Cell[][], total: number, max = MAX_ROWS): string {
  if (!columns.length) return '_No columns._';
  const head = '| ' + columns.map((c) => mdCell(c.name) || ' ').join(' | ') + ' |';
  const rule = '| ' + columns.map((c) => (c.type === 'number' ? '---:' : '---')).join(' | ') + ' |';
  const body = rows.slice(0, max).map((r) => '| ' + columns.map((_, i) => mdCell(r[i])).join(' | ') + ' |');
  const out = [head, rule, ...body];
  const more = total - Math.min(rows.length, max);
  if (more > 0) out.push('', `… ${more.toLocaleString('en-US')} more ${more === 1 ? 'row' : 'rows'}`);
  return out.join('\n');
}

function fence(lang: string, text: string): string {
  // A fence longer than any backtick run inside, so a statement cannot close it.
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = '`'.repeat(longest + 1);
  return `${f}${lang}\n${text.replace(/\s+$/, '')}\n${f}`;
}

function rowsLine(r: ExportResult): string {
  const n = r.rowCount.toLocaleString('en-US');
  const rows = r.truncated ? `${n}+ rows` : `${n} ${r.rowCount === 1 ? 'row' : 'rows'}`;
  return `_${rows}${typeof r.elapsedMs === 'number' ? ` · ${r.elapsedMs} ms` : ''}_`;
}

export function notebookMarkdown(input: ExportInput): string {
  const info = new Map(input.graph.cells.map((c) => [c.id, c]));
  const when = input.exportedAt || new Date();
  const parts: string[] = [`# ${input.name.replace(/\r?\n/g, ' ')}`, `_Exported from Ordinate on ${when.toISOString().slice(0, 10)}._`];
  for (const c of input.cells) {
    const i = info.get(c.id);
    const heading = (fallback: string): string => `### ${c.title || (i && i.view) || fallback}`;
    if (c.kind === 'markdown') {
      if (c.text.trim()) parts.push(c.text.trim());
      continue;
    }
    if (c.kind === 'param') {
      parts.push(`**Parameter** \`[[${c.name}]]\` = ${c.value === null ? '_no value_' : `\`${String(c.value)}\``} (${c.type})`);
      continue;
    }
    if (c.kind === 'chart') {
      parts.push(heading('Chart'));
      const png = input.charts[c.id];
      parts.push(png && PNG_RE.test(png) ? `![${(c.title || 'Chart').replace(/[[\]]/g, '')}](${png})` : '_The chart had not been drawn when this was exported._');
      continue;
    }
    parts.push(heading(c.kind === 'sql' ? 'Query' : 'Formula'));
    parts.push(c.kind === 'sql' ? fence('sql', c.sql) : fence('', `[${c.column}] = ${c.expression}`));
    const r = input.results[c.id];
    if (!r) parts.push('_Not run._');
    else if ('error' in r) parts.push(`> **Error:** ${r.error.replace(/\r?\n/g, ' ')}`);
    else parts.push(mdTable(r.columns, r.rows, r.truncated ? r.rows.length : r.rowCount), rowsLine(r));
  }
  return parts.join('\n\n') + '\n';
}
