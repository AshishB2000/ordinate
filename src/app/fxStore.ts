// Multi-currency settings on disk, and the bundled sample rates — MAIN PROCESS.
//
// One file per project, userData/projects/<id>/fx.json: the project's target
// currency, where its rates come from, every column's currency declaration and
// any dashboard's own target. Its own file rather than keys on project.json or
// the dataset records, so declaring a currency never rewrites a table record
// and a dataset refresh can never drop a declaration.
//
// Writes are read-modify-write under recordFs.locked (every pod), atomic (temp
// sibling then rename). A corrupt or missing file reads as "nothing declared".
//
// The SAMPLE rates (src/analysis/fxSample.json) are the fallback whenever no
// rate dataset is configured or the configured one is gone. They are labelled
// "Sample rates, not live" on every surface where they are the active source.

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as appPaths from './paths';
import { isValidId } from './ids';
import { sanitizeSettings, sanitizeDecl, sanitizeSource, isCurrencyCode, cellDay, buildRates } from '../analysis/fx';
import type { FxSettings, RateRow, RateTable } from '../analysis/fx';
import * as recordFs from './recordFs';

function fxFile(projectId: string): string {
  return path.join(appPaths.userData(), 'projects', projectId, 'fx.json');
}

// getFx runs for every figure (ipc/fxQuery.ts), so the settings are cached —
// for at most FRESH_MS, keyed by the file (which carries the org): another
// pod's declaration is seen within a second, as orgConfig's settings are.
const FRESH_MS = 1_000;
const cache = new Map<string, { settings: FxSettings; at: number }>();

async function readFx(file: string): Promise<FxSettings> {
  try {
    return sanitizeSettings(JSON.parse(await recordFs.readFile(file, 'utf8')));
  } catch (_) {
    return sanitizeSettings(null); // none yet, or unreadable: nothing declared
  }
}

export async function getFx(projectId: string): Promise<FxSettings> {
  if (!isValidId(projectId)) return sanitizeSettings(null);
  const file = fxFile(projectId);
  const hit = cache.get(file);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.settings;
  const settings = await readFx(file);
  cache.set(file, { settings, at: Date.now() });
  return settings;
}

/** Read-modify-write under the file's lock, from a fresh read. Resolves to what was stored. */
function edit(projectId: string, fn: (s: FxSettings) => void): Promise<FxSettings | null> {
  if (!isValidId(projectId)) return Promise.resolve(null);
  const file = fxFile(projectId);
  return recordFs.locked(file, async (): Promise<FxSettings | null> => {
    const next = await readFx(file);
    fn(next);
    const clean = sanitizeSettings(next);
    try {
      await recordFs.access(path.dirname(file));
    } catch (_) {
      return null; // no such project
    }
    const tmp = file + '.' + randomUUID() + '.tmp';
    await recordFs.writeFile(tmp, JSON.stringify(clean, null, 2), 'utf8');
    await recordFs.rename(tmp, file);
    return clean;
  }).then((clean) => {
    if (clean) cache.set(file, { settings: clean, at: Date.now() }); // after COMMIT: a rolled-back save is never served
    return clean;
  });
}

/** Target ('' = workspace currency) and/or the rate source (null = sample rates). */
export function setProjectFx(projectId: string, patch: { target?: unknown; source?: unknown }): Promise<FxSettings | null> {
  return edit(projectId, (s) => {
    if (patch.target !== undefined) s.target = isCurrencyCode(patch.target) ? patch.target : '';
    if (patch.source !== undefined) s.source = sanitizeSource(patch.source);
  });
}

/** Declare (or with null, clear) one column's currency. */
export function setColumnCurrency(projectId: string, datasetId: string, column: string, decl: unknown): Promise<FxSettings | null> {
  if (!isValidId(datasetId) || typeof column !== 'string' || !column) return Promise.resolve(null);
  return edit(projectId, (s) => {
    const d = sanitizeDecl(decl);
    const map = { ...(s.columns[datasetId] || {}) };
    if (d) map[column] = d;
    else delete map[column];
    s.columns[datasetId] = map;
  });
}

/** A dashboard's own target, or null to follow the project. */
export function setDashboardCurrency(projectId: string, dashboardId: string, code: unknown): Promise<FxSettings | null> {
  if (!isValidId(dashboardId)) return Promise.resolve(null);
  return edit(projectId, (s) => {
    if (isCurrencyCode(code)) s.dashboards[dashboardId] = code;
    else delete s.dashboards[dashboardId];
  });
}

// ── The bundled sample ───────────────────────────────────────────────────────

export interface SampleRates {
  label: string;
  note: string;
  /** First and last month, 'YYYY-MM'. */
  from: string;
  to: string;
  currencies: string[];
  rows: RateRow[];
  table: RateTable;
}

let sample: SampleRates | null = null;

/** The sample rates: X→USD on the first of each month. Validated like any rate table. */
export function sampleRates(): SampleRates {
  if (sample) return sample;
  let raw: any = {};
  try {
    raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'analysis', 'fxSample.json'), 'utf8'));
  } catch (_) {
    raw = {};
  }
  const months: string[] = Array.isArray(raw.months) ? raw.months.filter((m: unknown) => typeof m === 'string') : [];
  const quote = isCurrencyCode(raw.quote) ? raw.quote : 'USD';
  const rows: RateRow[] = [];
  const currencies: string[] = [];
  for (const [code, list] of Object.entries((raw.rates && typeof raw.rates === 'object' ? raw.rates : {}) as Record<string, unknown>)) {
    if (!isCurrencyCode(code) || !Array.isArray(list)) continue;
    currencies.push(code);
    months.forEach((m, i) => {
      const day = cellDay(m + '-01');
      const rate = list[i];
      if (day !== null && typeof rate === 'number' && Number.isFinite(rate) && rate > 0) rows.push({ from: code, to: quote, day, rate });
    });
  }
  sample = {
    label: typeof raw.label === 'string' ? raw.label : 'Sample rates, not live',
    note: typeof raw.note === 'string' ? raw.note : '',
    from: months[0] || '',
    to: months[months.length - 1] || '',
    currencies: [quote, ...currencies],
    rows,
    table: buildRates(rows),
  };
  return sample;
}
