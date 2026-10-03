import { ipcMain } from './bus';
import * as datasets from '../data/datasets';
import { sampleRowsResident } from '../engine/statsResident';
import { loadPlanContext, type PlanDataset } from '../analysis/analysisPlan';
import { resolveGeoHits } from '../analysis/geoResolve';
import { mapRoles, type GeoHits, type RoleMapping, type DefinedMeasure } from '../analysis/templateRoles';
import * as metrics from '../analysis/metrics';
import { TEMPLATES, templateById } from '../analysis/templates';
import * as userTemplates from '../app/userTemplateStore'; // r7:templates

// TEMPLATES IPC — the gallery's two channels. NOT an AI path: both work with no
// model configured, because a template is app code reading app-computed column
// summaries. Registered from src/main.ts beside `analyses`.
//
//   template:list  Every template, with the column mapping it would use on the
//                  chosen dataset and, for the ones that cannot map their
//                  required roles, the reason the card is dimmed.
//   template:plan  One template + a (possibly user-edited) mapping → an ordinary
//                  AnalysisPlan. The renderer hands that straight to the
//                  EXISTING `analysis:previewPlan` and `analysis:buildPlan`
//                  channels, so nothing here validates, previews or builds.
//
// Nothing in this file computes a figure and nothing hydrates a table: the role
// mapping reads DatasetMeta plus the resident per-column summaries, and the geo
// signal reads GEO_SAMPLE_ROWS rows off the stored Parquet with a LIMIT.

/**
 * Rows read to decide whether a text column holds PLACES.
 *
 * Small on purpose. The question is "do these values resolve to a geography",
 * which a few dozen distinct values answer as well as a million do — and
 * `sampleRowsResident` is ordered, so the answer is the same on every run.
 */
const GEO_SAMPLE_ROWS = 200;

/** Text columns' sample values, for the geo signal only. Never returned to the
 *  renderer — a sample value is a cell out of the table. */
export async function geoHitsFor(projectId: string, ds: PlanDataset): Promise<GeoHits> {
  const textCols = ds.columns
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.type === 'text');
  if (textCols.length === 0) return {};
  const src = await datasets.residentSource(projectId, ds.id);
  // A non-resident dataset contributes no geo signal, for the same reason
  // loadPlanContext gives it no summaries: it is never worth a hydrate.
  const rows = src ? await sampleRowsResident(src, GEO_SAMPLE_ROWS) : null;
  if (!rows) return {};
  const samples: Record<string, (string | number | null)[]> = {};
  for (const { c, i } of textCols) samples[c.name] = rows.map((r) => r[i] ?? null);
  return resolveGeoHits(samples);
}

/**
 * The reason a card is dimmed, or '' when it can be built.
 *
 * Capped at two named columns plus a count. The line sits under a 200px card
 * and a fourth name only ever reached the user as an ellipsis, which says less
 * than "and 2 more" does.
 */
const REASON_NAMED_MAX = 2;

export function reasonFor(missing: string[]): string {
  if (missing.length === 0) return '';
  const labels = missing.map((l) => l.toLowerCase());
  if (labels.length === 1) return `Needs a ${labels[0]} column`;
  if (labels.length <= REASON_NAMED_MAX) return `Needs ${labels[0]} and ${labels[1]} columns`;
  const named = labels.slice(0, REASON_NAMED_MAX).join(', ');
  return `Needs ${named} and ${labels.length - REASON_NAMED_MAX} more`;
}

export function register() {
  ipcMain.handle('template:list', async (_e, { projectId, datasetId }: any = {}) => {
    try {
      const ctx = await loadPlanContext(projectId, typeof datasetId === 'string' ? datasetId : undefined);
      const ds = ctx.datasets[0];
      if (!ds) return { ok: false, error: 'Import a dataset first — a template builds from one.' };
      const geoHits = await geoHitsFor(projectId, ds);
      // The project's own names for its numbers. A template's measure role
      // takes the matching metric's column rather than whichever numeric column
      // scored highest — the user already said which one is Revenue. Formula
      // metrics are skipped: a role resolves to a COLUMN and a ratio is not one.
      const defined: DefinedMeasure[] = (await metrics.listMetrics(projectId))
        .filter((m) => m.datasetId === ds.id)
        .map((m) => {
          const def = m.definition as { column?: string };
          return { id: m.id, name: m.name, column: def && def.column ? def.column : '' };
        })
        .filter((m) => m.column);
      const templates = TEMPLATES.map((t) => {
        const { matches, missingRequired } = mapRoles(t.roles, ds, geoHits, defined);
        return {
          id: t.id,
          group: t.group,
          name: t.name,
          blurb: t.blurb,
          thumb: t.thumb,
          roles: t.roles.map((r) => ({ id: r.id, label: r.label, kind: r.kind, required: r.required })),
          matches,
          missingRequired,
          reason: reasonFor(missingRequired),
        };
      });
      // r7:templates — the user's own templates, FIRST, through the same mapper.
      // `tiles` is the card count, the denominator of "N skipped".
      const yours = (await userTemplates.listTemplates()).map((t) => {
        const { matches, missingRequired } = mapRoles(t.roles, ds, geoHits, defined);
        return {
          id: t.id, group: 'Yours', user: true, name: t.name, blurb: t.description, thumb: '', thumbnail: t.thumbnail,
          roles: t.roles.map((r) => ({ id: r.id, label: r.label, kind: r.kind, required: r.required })),
          matches, missingRequired, reason: reasonFor(missingRequired),
          tiles: t.body.sheets.reduce((n: number, p) => n + (((p as { cards?: unknown[] }).cards) || []).length, 0),
        };
      });
      // The COLUMNS the mapping step's selects offer, with their declared type
      // for the glyph. Names and types only — no rows, no summaries, no values.
      const columns = ds.columns.map((c) => ({ name: c.name, type: c.type }));
      return { ok: true, datasetId: ds.id, datasetName: ds.name, columns, templates: [...yours, ...templates] };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to read the templates' };
    }
  });

  ipcMain.handle('template:plan', async (_e, { projectId, datasetId, templateId, mapping, name }: any = {}) => {
    try {
      const t = templateById(typeof templateId === 'string' ? templateId : '');
      if (!t) return { ok: false, error: 'Unknown template.' };
      const ctx = await loadPlanContext(projectId, typeof datasetId === 'string' ? datasetId : undefined);
      const ds = ctx.datasets[0];
      if (!ds) return { ok: false, error: 'That dataset could not be read.' };

      // The mapping arrives from the renderer, so it is untrusted: keep only
      // entries naming one of THIS template's roles and one of THIS dataset's
      // real columns. Everything else is dropped, which reads to the factory as
      // "that role did not map" — the case every tile already handles.
      const roleIds = new Set(t.roles.map((r) => r.id));
      const colNames = new Set(ds.columns.map((c) => c.name));
      const clean: RoleMapping = {};
      const raw = mapping && typeof mapping === 'object' ? (mapping as Record<string, unknown>) : {};
      for (const k of Object.keys(raw)) {
        const v = raw[k];
        if (roleIds.has(k) && typeof v === 'string' && colNames.has(v)) clean[k] = v;
      }
      // A REQUIRED role with no column is not a smaller dashboard, it is a
      // different one — refuse rather than build half of it silently.
      const missing = t.roles.filter((r) => r.required && !clean[r.id]).map((r) => r.label);
      if (missing.length) return { ok: false, error: reasonFor(missing) + '.' };

      const geoHits = await geoHitsFor(projectId, ds);
      const plan = t.build(ds, clean, {
        name: typeof name === 'string' && name.trim() ? name.trim() : undefined,
        geoHits,
      });
      return { ok: true, plan };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to build the template plan' };
    }
  });
}
