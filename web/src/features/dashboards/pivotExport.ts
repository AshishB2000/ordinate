// A pivot card's "Copy as table" / "Export CSV" (legacy pivotRender.ts
// pivotToRows / pivotToTsv / pivotToCsv). The grid is the SERVER's PivotGrid —
// every cell and subtotal as computed, formatted here with T1.2's pivotFmt —
// asked for through the Share policy's EXPORT path, since both put it outside
// the app. Deliberately the FULL grid, collapsed rows included: a paste that
// silently dropped rows someone folded for reading would be a trap.

import { calcKind, pivotFmt, valueOf, type PivotGridShape } from '../../charts/grids/model';
import { toCsv } from '../../charts/grids/model';

export function pivotToRows(grid: PivotGridShape): string[][] {
  const out: string[][] = [];
  const depth = grid.colHeaders.length ? Math.max(...grid.colHeaders.map((h) => h.length)) : 1;
  for (let level = 0; level < depth; level += 1) {
    const head = [''];
    for (const h of grid.colHeaders) head.push(h[level] ?? '');
    if (grid.rowTotals) for (let vi = 0; vi < grid.valueCount; vi += 1) head.push(level === 0 ? 'Total' : '');
    out.push(head);
  }
  grid.cells.forEach((row, r) => {
    const path = grid.rowHeaders[r] || [];
    // Indented with spaces so the hierarchy survives a paste into a cell that has no levels.
    const line = ['  '.repeat(Math.max(0, path.length - 1)) + (path[path.length - 1] ?? '')];
    row.forEach((v, c) => {
      const vi = valueOf(grid, c);
      line.push(pivotFmt(v, grid.showAs[vi], grid.formats[vi], calcKind(grid, vi)));
    });
    if (grid.rowTotals) for (let vi = 0; vi < grid.valueCount; vi += 1) line.push(pivotFmt(grid.rowTotals[r]?.[vi], 'value', grid.formats[vi]));
    out.push(line);
  });
  if (grid.colTotals || grid.grand) {
    const line = ['Total'];
    for (let c = 0; c < grid.colHeaders.length; c += 1) line.push(grid.colTotals ? pivotFmt(grid.colTotals[c], 'value', grid.formats[valueOf(grid, c)]) : '');
    if (grid.rowTotals) for (let vi = 0; vi < grid.valueCount; vi += 1) line.push(grid.grand ? pivotFmt(grid.grand[vi], 'value', grid.formats[vi]) : '');
    out.push(line);
  }
  return out;
}

/** TSV for a spreadsheet paste: a tab or newline inside a value becomes a space (TSV has no quoting). */
export function pivotToTsv(grid: PivotGridShape): string {
  const clean = (s: string): string => String(s).replace(/[\t\r\n]+/g, ' ');
  return pivotToRows(grid).map((r) => r.map(clean).join('\t')).join('\n');
}

export const pivotToCsv = (grid: PivotGridShape): string => toCsv(pivotToRows(grid));

/** Hands the browser a text file to save — no server round trip, the figures are already the server's. */
export function saveText(text: string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
