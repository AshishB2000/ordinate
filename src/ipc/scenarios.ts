// Scenarios IPC — the record's CRUD, and the reads that make one worth having:
// `scenario:compute` (baseline and scenario figures, the drivers in words, the
// tornado), `scenario:compare` (baseline + up to four scenarios side by side),
// `scenario:card` (one metric under a scenario, for a dashboard KPI card) and
// `scenario:targets` (what a driver can aim at). MAIN PROCESS.
//
// Every figure comes from src/analysis/scenarioResolve.ts; nothing is stored
// but definitions. Filters and parameters from a renderer are untrusted: they
// go through sanitizeDashboardFilters (a security control) and paramValues
// before anything is computed, exactly as `metric:compare` treats them.

import { ipcMain } from 'electron';

import * as scenarios from '../analysis/scenarios';
import * as metrics from '../analysis/metrics';
import { sanitizeDashboardFilters } from '../analysis/dashboards';
import { paramValues, resolveFilterParams } from '../analysis/params';
import { MAX_COMPARE, driverLabel, isMetricTarget, sanitizeBaseMetricIds, sanitizeDrivers } from '../analysis/scenarioModel';
import type { Scenario } from '../analysis/scenarioModel';
import { compareScenarios, computeScenario, scenarioCardValue, scenarioTargets } from '../analysis/scenarioResolve';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Drivers whitelisted, each named in words by the app — the name on disk is never stale. */
async function named(projectId: string, raw: unknown): Promise<unknown> {
  if (raw === undefined) return undefined;
  const out = [];
  for (const d of sanitizeDrivers(raw)) {
    const m = isMetricTarget(d.target) ? await metrics.getMetric(projectId, d.target.metricId) : null;
    out.push({ ...d, name: driverLabel(d, m ? m.name : 'Missing metric') });
  }
  return out;
}

// ponytail: `any` — the IPC payload is untrusted JSON, narrowed field by field.
async function create(projectId: string, input: any): Promise<Scenario | null> {
  const o = input && typeof input === 'object' ? input : {};
  return scenarios.saveScenario(projectId, { name: o.name, baseMetricIds: o.baseMetricIds, drivers: await named(projectId, o.drivers) });
}

export function register(): void {
  ipcMain.handle('scenario:list', async (_e, { projectId }: any = {}) => scenarios.listScenarios(id(projectId)));
  ipcMain.handle('scenario:get', async (_e, { projectId, id: sid }: any = {}) => scenarios.getScenario(id(projectId), id(sid)));
  ipcMain.handle('scenario:create', async (_e, { projectId, input }: any = {}) => {
    const s = await create(id(projectId), input);
    return s ? { ok: true, scenario: s } : { ok: false, error: 'Could not create the scenario.' };
  });
  ipcMain.handle('scenario:update', async (_e, { projectId, id: sid, patch }: any = {}) => {
    const pid = id(projectId);
    const p = patch && typeof patch === 'object' ? patch : {};
    const s = await scenarios.updateScenario(pid, id(sid), { name: p.name, baseMetricIds: p.baseMetricIds, drivers: await named(pid, p.drivers) });
    return s ? { ok: true, scenario: s } : { ok: false, error: 'Scenario not found.' };
  });
  ipcMain.handle('scenario:duplicate', async (_e, { projectId, id: sid }: any = {}) => {
    const s = await scenarios.duplicateScenario(id(projectId), id(sid));
    return s ? { ok: true, scenario: s } : { ok: false, error: 'Scenario not found.' };
  });
  ipcMain.handle('scenario:delete', async (_e, { projectId, id: sid }: any = {}) =>
    ({ ok: await scenarios.deleteScenario(id(projectId), id(sid)) }));

  /** The page's figures. `draft` (unsaved drivers/metrics) computes what a slider shows before it is saved. */
  ipcMain.handle('scenario:compute', async (_e, { projectId, id: sid, draft, focusMetricId }: any = {}) => {
    try {
      const s = await scenarios.getScenario(id(projectId), id(sid));
      if (!s) return { ok: false, error: 'Scenario not found.' };
      const d = draft && typeof draft === 'object' ? draft : null;
      const rec = d ? { ...s, baseMetricIds: sanitizeBaseMetricIds(d.baseMetricIds), drivers: sanitizeDrivers(d.drivers) } : s;
      return await computeScenario(s.projectId, rec, { focusMetricId: id(focusMetricId) });
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not compute the scenario.' };
    }
  });

  ipcMain.handle('scenario:compare', async (_e, { projectId, ids }: any = {}) => {
    try {
      const pid = id(projectId);
      const list: Scenario[] = [];
      for (const sid of Array.isArray(ids) ? ids : []) {
        if (list.length >= MAX_COMPARE || typeof sid !== 'string' || !UUID_RE.test(sid) || list.some((s) => s.id === sid)) continue;
        const s = await scenarios.getScenario(pid, sid);
        if (s) list.push(s);
      }
      if (!list.length) return { ok: false, error: 'Pick at least one scenario to compare.' };
      return await compareScenarios(pid, list);
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not compare the scenarios.' };
    }
  });

  ipcMain.handle('scenario:card', async (_e, { projectId, scenarioId, metricId, filters, params }: any = {}) => {
    try {
      const pid = id(projectId);
      if (!UUID_RE.test(id(metricId))) return { ok: false, error: 'Metric not found' };
      const s = await scenarios.getScenario(pid, id(scenarioId));
      if (!s) return { ok: false, error: 'Scenario not found' };
      const values = paramValues(params);
      const scope = resolveFilterParams(sanitizeDashboardFilters(filters), values).steps;
      const fig = await scenarioCardValue(pid, s, id(metricId), scope, values);
      return fig ? { ok: true, scenarioName: s.name, ...fig } : { ok: false, error: 'Metric not found' };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not compute the scenario.' };
    }
  });

  ipcMain.handle('scenario:targets', async (_e, { projectId, baseMetricIds }: any = {}) => {
    try {
      return await scenarioTargets(id(projectId), sanitizeBaseMetricIds(baseMetricIds));
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Could not read the metrics.' };
    }
  });
}
