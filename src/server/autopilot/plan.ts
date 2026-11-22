// What one weekly run does, decided from what it read (docs/autopilot/00-design.md, phase 3). Pure: no disk, no clock, no database,
// so every rule has a test that needs none (scripts/test-autopilotPlan.ts). Plain app logic, no model.

import { visualColumns } from '../../analysis/lineage';
import { joinsOtherData, otherColumns, namesString, repairedDefinition } from './repair';

type Rec = Record<string, any>; // any: a stored chart's loose shape

export interface VisualIn { id: string; name: string; datasetId: string; createdAt: string; encoding: Rec; filters: unknown[]; overrides?: Rec; analytics?: unknown[] }
export interface DatasetIn {
  id: string;
  name: string;
  columns: string[];
  /** Columns a Live dataset's warehouse no longer has (its record keeps the name while something uses it). */
  missing: string[];
  live: boolean;
  /** Certified, or certified and changed since (needs review): charts on it are never moved. */
  certified: boolean;
}
/** One logged rename (src/server/autopilot/renames.ts), in the order it was made. */
export interface RenameRow { datasetId: string; from: string; to: string; at: string; seq: number }
export interface Settings { windowDays: number; slowMs: number; trashUnused: boolean; repairRenames: boolean }

export interface PlanIn {
  /** The UTC day of the run, YYYY-MM-DD. */
  today: string;
  settings: Settings;
  visuals: VisualIn[];
  datasets: ReadonlyMap<string, DatasetIn>;
  renames: RenameRow[];
  /** Chart ids mentioned by any dashboard (draft or published copy), Story, report or alert. */
  usedElsewhere: ReadonlySet<string>;
  /** Saved metrics that are certified or need review. */
  certifiedMetrics: ReadonlySet<string>;
  usage: {
    /** The first day THIS PROJECT has a usage row (null: none yet). */
    firstDay: string | null;
    /** Per chart, the earliest day Autopilot can have watched it (when it first knew it, or its first usage row). A chart missing here is not a candidate. */
    firstSeen: ReadonlyMap<string, string>;
    /** Charts opened on or after the window's start. */
    openedSince: ReadonlySet<string>;
    /** The last 7 days per chart. */
    week: ReadonlyMap<string, { computes: number; totalMs: number; maxMs: number }>;
    /** Charts Autopilot moved to Trash within the window: if one came back, it is not moved again. */
    trashedBefore: ReadonlySet<string>;
  };
}

export type WhyNot = 'none' | 'again' | 'target_missing' | 'other_fields';
export interface Fix { from: string; to: string }
export interface Gone { column: string; why: WhyNot | 'repair_off'; suggest?: string }

export interface Plan {
  /** The first day a chart may be called unused, and whether that is today or before. */
  coveredFrom: string | null;
  covered: boolean;
  trash: Array<{ visualId: string; name: string }>;
  repair: Array<{ visualId: string; name: string; datasetId: string; fixes: Fix[] }>;
  broken: Array<{ visualId: string; name: string; datasetId: string; gone: Gone[] }>;
  slow: Array<{ visualId: string; name: string; datasetId: string; computes: number; avgMs: number; maxMs: number }>;
}

export const MIN_SLOW_COMPUTES = 3;

export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** For the missing `column` of `datasetId`: the rename that exactly explains it, or why none does. */
export function exactRename(rows: readonly RenameRow[], datasetId: string, column: string, d: DatasetIn): { to: string } | { why: WhyNot } {
  const mine = rows.filter((r) => r.datasetId === datasetId).sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
  let last = -1;
  mine.forEach((r, i) => { if (r.from === column) last = i; });
  if (last < 0) return { why: 'none' };
  const to = mine[last].to;
  if (mine.slice(last + 1).some((r) => r.from === to)) return { why: 'again' }; // renamed again since: not the name it has now
  if (!d.columns.includes(to) || d.missing.includes(to)) return { why: 'target_missing' };
  return { to };
}

export function planRun(i: PlanIn): Plan {
  const { settings: s, usage: u } = i;
  const cutoff = addDays(i.today, -s.windowDays);
  const coveredFrom = u.firstDay === null ? null : addDays(u.firstDay, 1);
  const covered = coveredFrom !== null && cutoff >= coveredFrom;
  const plan: Plan = { coveredFrom: coveredFrom === null ? null : addDays(coveredFrom, s.windowDays), covered, trash: [], repair: [], broken: [], slow: [] };

  for (const v of [...i.visuals].sort((a, b) => a.id.localeCompare(b.id))) {
    const d = i.datasets.get(v.datasetId);
    if (!d) continue; // its dataset is gone: the Trash took the chart with it, or it is not Autopilot's to judge
    const metricIds = (Array.isArray(v.encoding?.values) ? v.encoding.values : []).map((m: Rec) => m && m.metricId).filter(Boolean) as string[];
    const protectedChart = i.usedElsewhere.has(v.id) || d.certified || metricIds.some((m) => i.certifiedMetrics.has(m));
    // Candidate only if the chart was created AND watched for the whole window: a createdAt kept by an import proves nothing about being observed.
    const watched = (u.firstSeen.get(v.id) ?? i.today) <= cutoff;
    const unused = covered && watched && !protectedChart && !u.openedSince.has(v.id) && v.createdAt.slice(0, 10) <= cutoff && !u.trashedBefore.has(v.id);
    if (unused) {
      plan.trash.push({ visualId: v.id, name: v.name });
      continue; // moving it is the whole story: it is not also repaired or flagged
    }

    if (!joinsOtherData(v.encoding)) {
      const gone = [...new Set(visualColumns(v))].filter((c) => !d.columns.includes(c) || d.missing.includes(c));
      const fixes: Fix[] = [];
      const left: Gone[] = [];
      for (const column of gone) {
        const r = exactRename(i.renames, d.id, column, d);
        if ('to' in r && s.repairRenames) fixes.push({ from: column, to: r.to });
        else if ('to' in r) left.push({ column, why: 'repair_off', suggest: r.to });
        else left.push({ column, why: r.why });
      }
      // A column a map, a facet, a cohort or a funnel names is not in the fields a repair rewrites. Missing there: listed. And a name the repair would
      // leave behind anywhere (those fields, the styling, an overlay) means the chart would still fail: not repaired, listed.
      for (const column of otherColumns(v.encoding)) if (!d.columns.includes(column) || d.missing.includes(column)) if (!left.some((l) => l.column === column) && !fixes.some((f) => f.from === column)) left.push({ column, why: 'other_fields' });
      if (fixes.length) {
        const after = repairedDefinition(v, new Map(fixes.map((f) => [f.from, f.to])));
        for (const f of [...fixes]) {
          if (namesString(after.encoding, f.from) || namesString(v.overrides, f.from) || namesString(v.analytics, f.from) || otherColumns(v.encoding).includes(f.from)) {
            fixes.splice(fixes.indexOf(f), 1);
            left.push({ column: f.from, why: 'other_fields', suggest: f.to });
          }
        }
      }
      if (fixes.length) plan.repair.push({ visualId: v.id, name: v.name, datasetId: d.id, fixes });
      if (left.length) plan.broken.push({ visualId: v.id, name: v.name, datasetId: d.id, gone: left });
    }

    const w = u.week.get(v.id);
    if (w && w.computes >= MIN_SLOW_COMPUTES && w.totalMs / w.computes > s.slowMs) {
      plan.slow.push({ visualId: v.id, name: v.name, datasetId: d.id, computes: w.computes, avgMs: Math.round(w.totalMs / w.computes), maxMs: w.maxMs });
    }
  }
  plan.slow.sort((a, b) => b.avgMs - a.avgMs || a.visualId.localeCompare(b.visualId));
  return plan;
}
