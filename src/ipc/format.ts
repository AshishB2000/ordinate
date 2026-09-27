// Formatting depth IPC — the project's category colour map (read, deal, set,
// reset, re-deal). Chart formatting itself needs no IPC: it rides on a visual's
// `overrides`, which `visual:update` already writes and `visuals.ts` clamps.
//
// Main is the source of truth for the map. The renderer colours a chart
// synchronously from its cached copy using the SAME pure rule
// (analysis/colorMap.ts), then asks main to deal the same values against the
// STORED map; main writes only when that changes something and answers with
// the stored column, which the renderer adopts. So a stale cache heals on the
// next draw instead of overwriting a colour someone set elsewhere.
//
// Every write is a read-modify-write of project.json, and a dashboard draws
// several charts at once — each dealing colours for its own column. Writes are
// therefore serialized per project, or two overlapping deals would each write
// back the map they read and one column's colours would silently vanish.

import { ipcMain } from 'electron';
import * as projects from '../app/projects';
import * as colorMap from '../analysis/colorMap';
import type { ColorMap, ColumnColors } from '../analysis/colorMap';

/** Values accepted in one call — a dealt chart never draws more than this many categories. */
const MAX_VALUES_PER_CALL = 1000;

const queues = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier write for this project has settled. */
function serialized<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(projectId) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => undefined);
  queues.set(projectId, tail);
  void tail.then(() => { if (queues.get(projectId) === tail) queues.delete(projectId); });
  return next;
}

function columnOf(raw: unknown): string {
  return typeof raw === 'string' && raw && raw.length <= colorMap.MAX_COLOR_KEY ? raw : '';
}

function valuesOf(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw.slice(0, MAX_VALUES_PER_CALL) : [];
}

/**
 * Read the project's map, let `edit` return the column's next colours, and
 * write only when they differ. Resolves to the STORED column (or null when the
 * project is missing or the column name is unusable).
 */
function editColumn(
  projectId: unknown, column: unknown, edit: (cur: ColumnColors | undefined) => ColumnColors,
): Promise<{ colors: ColumnColors; changed: boolean } | null> {
  const col = columnOf(column);
  if (typeof projectId !== 'string' || !col) return Promise.resolve(null);
  return serialized(projectId, async () => {
    const project = await projects.getProject(projectId);
    if (!project) return null;
    const map: ColorMap = colorMap.sanitizeColorMap(project.colorMap);
    const cur = map[col];
    const next = edit(cur);
    if (colorMap.sameColumn(cur, next)) return { colors: cur || colorMap.emptyColumn(), changed: false };
    if (Object.keys(next).length) map[col] = next;
    else delete map[col];
    const stored = await projects.setColorMap(projectId, map);
    return { colors: (stored && stored[col]) || colorMap.emptyColumn(), changed: true };
  });
}

export function register(): void {
  ipcMain.handle('format:colors:get', async (_e, { projectId }: { projectId?: unknown } = {}) => {
    if (typeof projectId !== 'string') return {};
    const project = await projects.getProject(projectId);
    return project ? colorMap.sanitizeColorMap(project.colorMap) : {};
  });

  // A chart is about to draw these values of this column, in this order.
  ipcMain.handle('format:colors:assign', async (_e, { projectId, column, values }: Record<string, unknown> = {}) =>
    editColumn(projectId, column, (cur) => colorMap.assignColors(cur, valuesOf(values)).colors));

  // The profile's swatch picker: one value → one slot, or null to forget it.
  ipcMain.handle('format:colors:set', async (_e, { projectId, column, value, token }: Record<string, unknown> = {}) =>
    editColumn(projectId, column, (cur) => colorMap.setColor(cur, value, token)));

  // "Reset": the column's values are dealt afresh as they are next drawn.
  ipcMain.handle('format:colors:reset', async (_e, { projectId, column }: Record<string, unknown> = {}) =>
    editColumn(projectId, column, () => colorMap.emptyColumn()));

  // "Apply palette": deal every listed value again, in this order.
  ipcMain.handle('format:colors:palette', async (_e, { projectId, column, values }: Record<string, unknown> = {}) =>
    editColumn(projectId, column, () => colorMap.applyPalette(valuesOf(values))));
}
