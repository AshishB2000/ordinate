// Server-only Visuals channels (T2.7). ./visuals.ts sits at its size cap, so
// what only the web app needs lives here.
//
//   visual:thumbs        the gallery's live thumbnails in ONE call: each saved
//                        visual's own `visual:data`, from its STORED definition,
//                        answered by the very handler `visual:data` runs
//   visual:rowsDownload  the drill panel's "Export these rows (CSV)": the desktop
//                        handler's row set and file, offered as a download token
//                        (T0.4) instead of a native save dialog
//   period:picker        the relative-period picker's presets with their NAMES,
//                        and a spec's resolved dates — both main's, because both
//                        depend on today and the workspace calendar
//
// Plus the registrations the screen needs from modules other screens own too
// (guarded: a second register() of a module throws).

import { randomUUID } from 'crypto';
import * as path from 'path';
import { ipcMain } from './bus';
import { handlers } from '../server/rpc';
import { offerDownload } from '../server/files';
import * as appPaths from '../app/paths';
import { formatDateRange } from '../app/format';
import * as visuals from '../analysis/visuals';
import * as datasets from '../data/datasets';
import { paramValues, resolveFilterParams } from '../analysis/params';
import { rowShaper } from '../app/sharePolicy';
import { describePeriod, getCalendar, resolvePeriodNow, sanitizePeriod, type PeriodSpec } from '../analysis/dateIntel';
import { pageFor } from './datasets';
import { csvFileName, resolveDrill, writeDrillCsv } from './visuals';

/** The picker's quick picks, short to long (periodPicker.ts PP_GROUPS). */
const PERIOD_GROUPS: { title: string; items: PeriodSpec[] }[] = [
  { title: 'Days', items: [{ preset: 'today' }, { preset: 'yesterday' }, { preset: 'last_n_days', n: 7 }, { preset: 'last_n_days', n: 30 }, { preset: 'last_n_days', n: 90 }] },
  {
    title: 'Weeks and months',
    items: [{ preset: 'this_week' }, { preset: 'last_week' }, { preset: 'this_month' }, { preset: 'last_month' }, { preset: 'last_n_months', n: 3 }, { preset: 'last_n_months', n: 12 }],
  },
  {
    title: 'Quarters and years',
    items: [{ preset: 'this_quarter' }, { preset: 'last_quarter' }, { preset: 'qtd' }, { preset: 'this_year' }, { preset: 'last_year' }, { preset: 'ytd' }],
  },
];
const PERIOD_UNITS = [
  { preset: 'last_n_days', label: 'days' },
  { preset: 'last_n_weeks', label: 'weeks' },
  { preset: 'last_n_months', label: 'months' },
  { preset: 'last_n_quarters', label: 'quarters' },
  { preset: 'last_n_years', label: 'years' },
];

export function register(): void {
  ipcMain.handle('visual:thumbs', async (e, { projectId, ids }: { projectId: string; ids: string[] }) => {
    const data = handlers.get('visual:data');
    if (!data) return ids.map((id) => ({ id, ok: false, error: 'Charts are not available on this server.' }));
    return Promise.all(
      ids.map(async (id) => {
        const v = await visuals.getVisual(projectId, id);
        if (!v) return { id, ok: false, error: 'That visual no longer exists.' };
        const reply = (await data(e, { projectId, datasetId: v.datasetId, encoding: v.encoding, filters: v.filters })) as object;
        return { ...reply, id, chartType: v.chartType, overrides: v.overrides };
      }),
    );
  });

  // The same arguments the panel's `visual:rows` took, so the file IS the grid:
  // same filters, search and order. The rows leave the app here, so the Share
  // policy shapes every row and the header (rowShaper 'export').
  ipcMain.handle('visual:rowsDownload', async (_e, { projectId, datasetId, encoding, filters, mark, page, name, params }: any = {}) => { // any: zod-checked at the door
    try {
      const enc = visuals.sanitizeEncoding(encoding);
      const flt = resolveFilterParams(visuals.sanitizeFilters(filters), paramValues(params)).steps;
      const meta = await datasets.getDatasetMeta(projectId, datasetId);
      if (!meta) return { ok: false, error: 'Dataset not found' };
      const resolved = resolveDrill(meta.columns, enc, flt, mark);
      if (!resolved.available) return { ok: false, error: resolved.reason };
      const p = page && typeof page === 'object' ? page : {};
      const base = { offset: 0, limit: 0, search: p.search, sortColumn: p.sortColumn, sortDir: p.sortDir, filters: resolved.filters };
      const counted = await pageFor(projectId, datasetId, base, 'drillExport');
      if (!counted.ok) return counted;
      if (counted.total === 0) return { ok: false, error: 'There are no rows to export.' };
      const shaper = await rowShaper(projectId, datasetId, meta.columns, 'export');
      const file = path.join(appPaths.temp(), `drill-${randomUUID()}.csv`);
      const rows = await writeDrillCsv(file, projectId, datasetId, base, shaper.columns, counted.total, shaper.row);
      return { ok: true, rows, ...offerDownload(file, csvFileName(name)) };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to export the rows' };
    }
  });

  ipcMain.handle('period:picker', async (_e, { spec }: { spec?: unknown } = {}) => {
    const cal = getCalendar();
    const label = (s: PeriodSpec) => describePeriod(s, cal);
    const fiscal = cal.calendarType && cal.calendarType !== 'gregorian' ? cal.calendarType !== 'iso' : Number(cal.fiscalYearStart) > 1;
    const out: Record<string, unknown> = {
      groups: PERIOD_GROUPS.map((g) => ({ title: g.title, items: g.items.map((s) => ({ spec: s, label: label(s) })) })),
      units: PERIOD_UNITS,
      fiscal,
    };
    const s = spec === undefined ? null : sanitizePeriod(spec);
    if (s) {
      const r = resolvePeriodNow(s);
      out.current = { spec: s, label: label(s), ...(r ? { from: r.from, to: r.to, range: formatDateRange(r.from, r.to) } : {}) };
    }
    return out;
  });
}
