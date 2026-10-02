// Multi-currency IPC — the project's target and rate source, a column's
// currency declaration, a dashboard's own target, and a column's coverage
// ("how many rows have no rate"). The conversion itself happens where the
// figures are computed (./fxQuery); nothing here computes a number of its own —
// coverage IS `computeCardMetric`'s converted sum, so it cannot disagree with a
// tile.

import { ipcMain } from 'electron';
import * as fxStore from '../app/fxStore';
import { COMMON_CODES } from '../analysis/fx';
import type { FxSettings } from '../analysis/fx';
import { getFormatPrefs } from '../app/format';
import { computeCardMetric } from './dashboards';
import { fxScope, fxTarget } from './fxQuery';

async function view(projectId: string, s: FxSettings | null): Promise<any> {
  if (!s) return { ok: false, error: 'Project not found' };
  const sample = fxStore.sampleRates();
  return {
    ok: true,
    settings: s,
    target: await fxTarget(projectId),
    workspaceCurrency: getFormatPrefs().currency,
    codes: COMMON_CODES,
    sample: { label: sample.label, note: sample.note, from: sample.from, to: sample.to, currencies: sample.currencies },
  };
}

export function register(): void {
  ipcMain.handle('fx:get', async (_e, { projectId }: any = {}) => view(projectId, await fxStore.getFx(projectId)));

  ipcMain.handle('fx:set', async (_e, { projectId, patch }: any = {}) =>
    view(projectId, await fxStore.setProjectFx(projectId, patch && typeof patch === 'object' ? patch : {})));

  ipcMain.handle('fx:column', async (_e, { projectId, datasetId, column, decl }: any = {}) =>
    view(projectId, await fxStore.setColumnCurrency(projectId, datasetId, column, decl)));

  ipcMain.handle('fx:dashboard', async (_e, { projectId, dashboardId, code }: any = {}) =>
    view(projectId, await fxStore.setDashboardCurrency(projectId, dashboardId, code)));

  // The column profile's line: the column's converted sum under no filter.
  ipcMain.handle('fx:coverage', async (_e, { projectId, datasetId, column, currency }: any = {}) => fxScope(currency, async () => {
    try {
      if (typeof column !== 'string' || !column) return { ok: false, error: 'No column' };
      const r = await computeCardMetric(projectId, datasetId, { column, aggregation: 'sum' }, []);
      return r.ok ? { ok: true, value: r.value, fx: r.fx || null } : { ok: false, error: 'Dataset not found' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to check the conversion' };
    }
  }));
}
