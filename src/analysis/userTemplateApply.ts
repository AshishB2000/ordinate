// Applying a USER TEMPLATE to a dataset — the role mapping in, the records to
// create out. MAIN PROCESS, PURE: the IPC layer (src/ipc/userTemplates.ts)
// creates what this plans, through the ordinary record APIs, and nothing else.
//
// The mapping comes from the gallery's mapping step — the SAME `mapRoles` and
// the same selects as a built-in template. A REQUIRED role left unmapped blocks
// the apply; an OPTIONAL one drops everything that needs it — a tile, a
// dashboard filter, a calculated field and anything that reads that field, a
// metric and every tile that shows it — each with a line saying what and why,
// the way the built-ins report "2 tiles skipped".
//
// Calculated fields and metrics are recreated on the target WITHOUT duplicates:
// one that already exists there with the same name and the same definition is
// reused (so a template applied back to its own dataset adds nothing), and one
// whose name is taken by something different gets the next free "Name 2".

import type { ParsedColumn } from '../data/parse';
import type { RoleMapping, TemplateRole } from './templateRoles';
import type { TemplateBody } from './userTemplate';
import {
  formulaFromRefs, formulaRefs, isRef, jsonFromRefs, refsIn, swapStrings, type RefResolver,
} from './userTemplateRefs';

export interface ApplyTarget {
  datasetId: string;
  columns: ParsedColumn[];
  /** The target dataset's existing pipeline. */
  steps: unknown[];
  /** Every metric in the target PROJECT — metric names are project-wide. */
  metrics: Array<{ id: string; name: string; datasetId: string; definition: unknown }>;
  /** roleId → the geography its target column resolves to (RoleMatch.geoLevel). */
  geoLevels?: Record<string, string>;
}

type Obj = Record<string, unknown>;

export interface ApplyPlan {
  name: string;
  /** calculated_field steps to APPEND to the target's pipeline. */
  newSteps: Array<{ type: 'calculated_field'; name: string; expression: string }>;
  /** In creation order (dependencies first). `reuseId` = already there. */
  metrics: Array<{ ref: string; reuseId?: string; input?: Obj }>;
  /** saveVisual inputs; `{ $ref: 'm…' }` metric ids are bound after the metrics exist. */
  visuals: Array<{ ref: string; input: Obj }>;
  /** saveAnalysis input; `{ $ref: 'v…' | 'm…' }` bound once those records exist. */
  analysis: { name: string; sheets: unknown[]; filters: unknown[]; style: unknown; parameters: unknown[] };
  /** One user-facing line per element left out. */
  dropped: string[];
  tiles: number;
  total: number;
  /** The KPI tiles as `{datasetId, column, aggregation, label}`, for the mapping step's live figures. */
  kpis: Obj[];
}

const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
/** Region levels a choropleth draws from NAMES — the ones a target column may resolve differently. */
const REGION_LEVELS = new Set(['country', 'us_state', 'us_county']);

/** Order-blind JSON equality for small definitions. */
function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => (Array.isArray(v) ? v.map(norm) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v as Obj).sort().map((k) => [k, norm((v as Obj)[k])])) : v);
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

export function planApply(
  t: { name: string; roles: TemplateRole[]; body: TemplateBody },
  mapping: RoleMapping,
  target: ApplyTarget,
  opts: { name?: string; newId: () => string },
): ApplyPlan {
  const body = t.body;
  const cols = new Set(target.columns.map((c) => c.name));
  /** ref → the NAME it writes back as (or the dataset id, for `ds`). */
  const avail = new Map<string, string>([['ds', target.datasetId]]);
  for (const r of t.roles) if (mapping[r.id] && cols.has(mapping[r.id])) avail.set(r.id, mapping[r.id]);
  const keptVisuals = new Set<string>();
  const dropped: string[] = [];

  // What a missing ref is called in a "needs …" line.
  const label = (id: string): string => {
    const r = t.roles.find((x) => x.id === id);
    if (r) return r.label;
    const c = body.calcFields.find((x) => x.ref === id);
    if (c) return `the calculated field ${c.name}`;
    const m = body.metrics.find((x) => x.ref === id);
    if (m) return `the metric ${m.name}`;
    const v = body.visuals.find((x) => x.ref === id);
    return v ? `the chart ${String(v.spec.name || '')}` : id;
  };
  const missing = (needs: Set<string>): string[] =>
    [...needs].filter((id) => !avail.has(id) && !keptVisuals.has(id));
  const needsLine = (miss: string[]): string => miss.map(label).join(', ');

  const slot: RefResolver = (id) => (id.startsWith('m') || id.startsWith('v') ? undefined : avail.get(id) ?? null);
  const name: RefResolver = (id) => avail.get(id) ?? null;
  const fallback = (id: string): string => body.metrics.find((m) => m.ref === id)?.name || id;
  const resolve = (v: unknown): unknown => jsonFromRefs(v, slot, name, fallback);

  // 1. Calculated fields, in pipeline order.
  const existingCalc = new Map<string, string>();
  for (const s of target.steps) {
    const o = obj(s);
    if (o.type === 'calculated_field' && typeof o.name === 'string') existingCalc.set(o.name, String(o.expression));
  }
  const taken = new Set<string>([...cols, ...existingCalc.keys()]);
  const newSteps: ApplyPlan['newSteps'] = [];
  for (const cf of body.calcFields) {
    const miss = missing(new Set(formulaRefs(cf.expression)));
    const expression = miss.length ? null : formulaFromRefs(cf.expression, name);
    if (expression === null) {
      dropped.push(`Calculated field “${cf.name}” — needs ${needsLine(miss)}`);
      continue;
    }
    if (existingCalc.get(cf.name) === expression) { avail.set(cf.ref, cf.name); continue; }
    let n = cf.name;
    for (let i = 2; taken.has(n); i += 1) n = `${cf.name} ${i}`;
    taken.add(n);
    newSteps.push({ type: 'calculated_field', name: n, expression });
    avail.set(cf.ref, n);
  }

  // 2. Metrics — captured dependencies first, so one pass sees every drop.
  const takenMetric = new Set(target.metrics.map((m) => m.name.toLowerCase()));
  const metrics: ApplyPlan['metrics'] = [];
  for (const m of body.metrics) {
    const miss = missing(refsIn(m.spec));
    if (miss.length) { dropped.push(`Metric “${m.name}” — needs ${needsLine(miss)}`); continue; }
    const spec = resolve(m.spec) as Obj;
    const reuse = target.metrics.find((x) => x.datasetId === target.datasetId
      && x.name.toLowerCase() === m.name.toLowerCase() && same(x.definition, spec.definition));
    if (reuse) { metrics.push({ ref: m.ref, reuseId: reuse.id }); avail.set(m.ref, reuse.name); continue; }
    let n = m.name;
    for (let i = 2; takenMetric.has(n.toLowerCase()); i += 1) n = `${m.name} ${i}`;
    takenMetric.add(n.toLowerCase());
    metrics.push({ ref: m.ref, input: { ...spec, name: n, datasetId: target.datasetId } });
    avail.set(m.ref, n);
  }

  // 3. Visuals. A map whose region role resolved to a different geography on
  //    the target draws that geography — the column is the same either way.
  const visuals: ApplyPlan['visuals'] = [];
  for (const v of body.visuals) {
    const miss = missing(refsIn(v.spec));
    if (miss.length) { dropped.push(`Chart “${String(v.spec.name || '')}” — needs ${needsLine(miss)}`); continue; }
    const enc = obj(v.spec.encoding);
    const geo = obj(enc.geo);
    const level = isRef(enc.category) ? target.geoLevels?.[enc.category.$ref] : undefined;
    const spec = level && REGION_LEVELS.has(String(geo.level)) && REGION_LEVELS.has(level)
      ? { ...v.spec, encoding: { ...enc, geo: { ...geo, level } } } : v.spec;
    visuals.push({ ref: v.ref, input: { ...(resolve(spec) as Obj), datasetId: target.datasetId } });
    keptVisuals.add(v.ref);
  }

  // 4. Cards, filters, parameters.
  const visualName = (ref: string): string => String(body.visuals.find((v) => v.ref === ref)?.spec.name || 'Chart');
  const cardName = (c: Obj): string => {
    if (isRef(c.visualId)) return visualName(c.visualId.$ref);
    const m = obj(c.metric);
    const ctl = obj(c.control);
    return String(m.label || ctl.label || c.heading || c.type || 'Tile');
  };
  let total = 0;
  let tiles = 0;
  const kpis: Obj[] = [];
  const sheets = body.sheets.map((p) => {
    const page = obj(p);
    const cards: unknown[] = [];
    for (const raw of Array.isArray(page.cards) ? page.cards : []) {
      const c = obj(raw);
      total += 1;
      const miss = missing(refsIn(c));
      if (miss.length) { dropped.push(`Tile “${cardName(c)}” — needs ${needsLine(miss)}`); continue; }
      const out = resolve(c) as Obj;
      cards.push(out);
      tiles += 1;
      const m = obj(out.metric);
      if (out.type === 'metric' && m.column) {
        kpis.push({ datasetId: target.datasetId, column: m.column, aggregation: m.aggregation, label: m.label || m.column });
      }
    }
    return { ...page, cards } as Obj;
  });
  const filters: unknown[] = [];
  for (const f of body.filters) {
    const miss = missing(refsIn(f));
    if (miss.length) dropped.push(`A dashboard filter — needs ${needsLine(miss)}`);
    else filters.push(resolve(f));
  }
  // A list parameter whose options came from an unmapped column keeps its name
  // and value — formulas reference it by name — and loses only the option list.
  const parameters = body.parameters.map((p) => {
    const o = obj(p);
    return missing(refsIn(o.list)).length ? resolve({ ...o, list: [] }) : resolve(o);
  });

  // 5. Fresh ids for every page, card and parameter: they are per-dashboard
  //    keys, and two dashboards from one template must not share them.
  const fresh = new Map<string, string>();
  for (const p of sheets) {
    fresh.set(String(p.id), opts.newId());
    for (const c of p.cards as Obj[]) fresh.set(String(c.id), opts.newId());
  }
  for (const p of parameters) fresh.set(String(obj(p).id), opts.newId());
  fresh.delete('undefined');

  return {
    name: opts.name || t.name,
    newSteps,
    metrics,
    visuals,
    analysis: {
      name: opts.name || t.name,
      sheets: swapStrings(sheets, fresh) as unknown[],
      filters,
      style: body.style,
      parameters: swapStrings(parameters, fresh) as unknown[],
    },
    dropped,
    tiles,
    total,
    kpis,
  };
}

/** Bind the `{ $ref: 'm…' | 'v…' }` slots left by `planApply` to real record ids. */
export function bindIds<T>(v: T, ids: Map<string, string>): T {
  return jsonFromRefs(v, (id) => ids.get(id), () => undefined, (id) => id) as T;
}
