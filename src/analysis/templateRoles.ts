// SEMANTIC COLUMN MAPPING — which of this dataset's columns plays which part.
//
// A template says what it needs ("a date, a revenue measure, a category"); this
// file decides which real column each of those is, from the dataset's own
// metadata and the app's own per-column summaries. It is the whole reason the
// gallery can offer "Sales overview" to a table whose columns are called `Dt`
// and `Amt`.
//
// PURE and DETERMINISTIC in (template, dataset, samples). No model, no I/O of
// its own (`geoResolve` reads two shipped boundary files and caches them), no
// randomness, no Map iteration order anywhere a result depends on it. That is
// what makes scripts/test-templates.ts able to assert the mapping rather than
// eyeball it.
//
// FOUR SIGNALS, in one score:
//
//   1. NAME HINTS — matched on WORDS, never substrings, for the reason
//      starterPlan.ts already documents: a substring `count` matches "discount".
//   2. THE DECLARED TYPE — a hard gate. `007` is text and stays text, so a role
//      that needs a measure never takes a text column however it is named.
//   3. SHAPE — distinct counts from the app's summaries: a dimension is 2..200
//      distinct, an id is more than half distinct.
//   4. FOR `geo` ONLY — the share of real sample values that resolve to a
//      bundled geography, via the same matcher map_choropleth renders with.
//
// Signal 4 is what makes the sample dataset map Region→`state` rather than
// `region`: both match the role's name hints, and only one of them is a place
// the app can draw.

import type { ColumnSummary } from '../data/datasetStats';
import type { ParsedColumn } from '../data/parse';
import type { PlanDataset } from './analysisPlan';
import { words } from './starterPlan';
import type { ResolvedGeoLevel } from './geoResolve';

export type RoleKind = 'date' | 'measure' | 'dimension' | 'id' | 'geo';

export interface TemplateRole {
  id: string;
  label: string;
  kind: RoleKind;
  /** A template whose REQUIRED roles cannot all map is not offered at all. */
  required: boolean;
  /** Name fragments, matched as whole words. Lower-case. */
  hints: string[];
}

/** roleId → column name. An absent or empty entry means "not mapped". */
export type RoleMapping = Record<string, string>;

export type RoleConfidence = 'high' | 'medium' | 'low';

export interface RoleMatch {
  role: string;
  column: string; // '' when nothing scored above the floor
  confidence: RoleConfidence;
  /** For a `geo` role that resolved: the choropleth level its values belong to. */
  geoLevel?: ResolvedGeoLevel;
  /**
   * The defined Metric this role matched BY NAME, if one did.
   *
   * Reported, not consumed: `mappingOf` still hands the factories a plain
   * `{roleId: column}`, so every template builds exactly the chart it built
   * before. This is here so the caller can say WHY a column was chosen, and so
   * a future factory can link the tile to the metric without re-deriving the
   * match.
   */
  metricId?: string;
}

/**
 * A project's SIMPLE metrics, as the role mapper needs them.
 *
 * Formula metrics are deliberately absent: a template role resolves to a
 * COLUMN, and `[Profit] / [Revenue]` is not one.
 */
export interface DefinedMeasure {
  id: string;
  name: string;
  column: string;
}

export interface TemplateMapping {
  templateId: string;
  matches: RoleMatch[];
  /** Labels of the REQUIRED roles that found no column. */
  missingRequired: string[];
  /** '' when the template can be built; otherwise why it cannot, user-facing. */
  reason: string;
}

/**
 * column → the geography its sample VALUES resolve to, from `geoResolve`.
 *
 * Passed IN rather than computed here, which is what keeps this module pure: the
 * caller reads the samples (one `LIMIT` off the stored Parquet) and resolves
 * them once for the whole dataset, and a test can hand over either real resolved
 * hits or a literal.
 */
export type GeoHits = Record<string, { level: ResolvedGeoLevel; hitRate: number }>;

// ── Scoring ─────────────────────────────────────────────────────────────────
//
// The numbers are a ladder, not a calibration: a whole-name match beats a
// word match beats a partial, and the shape terms are smaller than the gap
// between those rungs so shape breaks ties rather than overturning names. The
// one exception is `geo`, whose evidence is the values themselves.

const NAME_WHOLE = 110; // the entire column name IS the hint ("region")
const NAME_WORD = 100; // one of its words is the hint ("order_date" ~ date)
const NAME_PARTIAL = 60; // a word contains the hint, or vice versa ("qty_ordered")
const SHAPE_DIMENSION = 30;
const SHAPE_DIMENSION_BAD = -40;
const SHAPE_ID = 40;
const GEO_WEIGHT = 120; // hit rate × this; the 0.6 floor alone clears the bar
/** A sum of unit prices is not a fact about a business — starterPlan.ts's rule. */
const AVERAGED_PENALTY = -50;
/** Below this a column is not this role's column, and the role stays unmapped. */
const SCORE_FLOOR = 60;

/** Rates and prices: additive-looking, never additive. (starterPlan's list.) */
const AVERAGED_WORDS = new Set([
  'price', 'rate', 'discount', 'margin', 'ratio', 'pct', 'percent', 'percentage',
  'score', 'avg', 'average', 'mean', 'median',
]);
/** Numbers that identify or locate rather than measure. */
const NOT_A_MEASURE_WORDS = new Set([
  'id', 'code', 'zip', 'postcode', 'year', 'month', 'day', 'week', 'quarter',
  'lat', 'lon', 'lng', 'latitude', 'longitude',
]);

/** A dimension narrow enough to be an axis and wide enough to be a split. */
const DIM_MIN_DISTINCT = 2;
const DIM_MAX_DISTINCT = 200;
/** An id repeats, but mostly does not: over half its non-empty cells are unique. */
const ID_MIN_DISTINCT_RATIO = 0.5;

function nameScore(colName: string, hints: string[]): number {
  const ws = words(colName);
  const whole = ws.join(' ');
  let best = 0;
  for (const hint of hints) {
    if (whole === hint) best = Math.max(best, NAME_WHOLE);
    if (ws.includes(hint)) best = Math.max(best, NAME_WORD);
    // Partial only for hints long enough to mean something: `id` and `dt` are
    // two letters and would match half the alphabet as substrings.
    if (hint.length >= 3 && ws.some((w) => w.includes(hint) || hint.includes(w))) {
      best = Math.max(best, NAME_PARTIAL);
    }
  }
  return best;
}

/** The DECLARED type a role's column must have. Never inferred from values. */
function typeAllowed(kind: RoleKind, type: ParsedColumn['type']): boolean {
  if (kind === 'date') return type === 'date';
  if (kind === 'measure') return type === 'number';
  if (kind === 'id') return type === 'text' || type === 'number';
  return type === 'text'; // dimension, geo
}

function summaryOf(ds: PlanDataset, name: string): ColumnSummary | undefined {
  // BY NAME — nothing states that summaries[] is index-aligned with columns[].
  return ds.summaries ? ds.summaries.find((s) => s.name === name) : undefined;
}

interface Scored {
  column: string;
  score: number;
  nameScore: number;
  shapeOk: boolean;
  geoLevel?: ResolvedGeoLevel;
}

/** Score one column for one role, or null when its declared type rules it out. */
function scoreColumn(
  role: TemplateRole,
  col: ParsedColumn,
  ds: PlanDataset,
  geoHits: GeoHits,
): Scored | null {
  if (!typeAllowed(role.kind, col.type)) return null;
  const ws = words(col.name);
  const name = nameScore(col.name, role.hints);
  let score = name;
  let shapeOk = true;
  let geoLevel: ResolvedGeoLevel | undefined;

  if (role.kind === 'measure') {
    // An id, a zip or a year is a number the way a phone number is.
    if (ws.some((w) => NOT_A_MEASURE_WORDS.has(w))) return null;
    if (ws.some((w) => AVERAGED_WORDS.has(w))) { score += AVERAGED_PENALTY; shapeOk = false; }
  }

  const s = summaryOf(ds, col.name);
  if (role.kind === 'dimension') {
    const d = s && typeof s.distinct === 'number' ? s.distinct : null;
    // No summary at all (a non-resident dataset) is not evidence against the
    // column — a wide axis is ugly, never wrong, and never worth a hydrate.
    shapeOk = d === null || (d >= DIM_MIN_DISTINCT && d <= DIM_MAX_DISTINCT);
    score += shapeOk ? SHAPE_DIMENSION : SHAPE_DIMENSION_BAD;
  }
  if (role.kind === 'id') {
    const d = s && typeof s.distinct === 'number' ? s.distinct : null;
    const n = s && typeof s.nonEmpty === 'number' ? s.nonEmpty : 0;
    shapeOk = d !== null && n > 0 && d / n > ID_MIN_DISTINCT_RATIO;
    if (shapeOk) score += SHAPE_ID;
  }
  if (role.kind === 'geo') {
    const hit = geoHits[col.name];
    shapeOk = !!hit;
    if (hit) { score += Math.round(hit.hitRate * GEO_WEIGHT); geoLevel = hit.level; }
  }

  return { column: col.name, score, nameScore: name, shapeOk, geoLevel };
}

function confidenceOf(s: Scored, kind: RoleKind): RoleConfidence {
  const base: RoleConfidence = s.nameScore >= NAME_WORD ? 'high' : s.nameScore >= NAME_PARTIAL ? 'medium' : 'low';
  // A name that reads right over a shape that does not is a guess worth showing,
  // not a guess worth trusting — say so with the dot rather than by dropping it.
  if (!s.shapeOk && kind !== 'measure') return base === 'high' ? 'medium' : 'low';
  return base;
}

/**
 * Which column plays each of this template's roles, on this dataset.
 *
 * A role maps to the highest-scoring column above `SCORE_FLOOR`, ties broken by
 * DECLARED COLUMN ORDER — so `category` beats `sub_category`, and re-running
 * this on the same dataset cannot produce a different answer.
 *
 * `date` is the one role that maps on type alone: a dataset's only date column
 * is its date column whatever it is called, and the floor would otherwise drop
 * a template for a table with a column named `when`.
 */
/**
 * The defined metric whose NAME plays this role, if one does.
 *
 * Matched on whole words against the role's own hints and label — the same
 * vocabulary the column scorer uses, so "Revenue" matches a `revenue` role and
 * "Avg order value" does not match a `units` one. The metric's column must
 * exist on THIS dataset and be numeric and unclaimed, because a role that
 * resolved to a column the dataset lacks is worse than one that resolved to a
 * merely-second-choice column.
 *
 * The first match in list order wins, and `listMetrics` sorts by name, so this
 * answers the same way on every machine.
 */
function namedMeasure(
  role: TemplateRole,
  ds: PlanDataset,
  defined: DefinedMeasure[],
  taken: Set<string>,
): DefinedMeasure | null {
  if (!defined.length) return null;
  const wanted = new Set<string>(role.hints.concat(words(role.label)));
  for (const m of defined) {
    if (!m.column || taken.has(m.column)) continue;
    const col = ds.columns.find((c) => c.name === m.column);
    if (!col || col.type !== 'number') continue;
    if (words(m.name).some((w) => wanted.has(w))) return m;
  }
  return null;
}

export function mapRoles(
  roles: TemplateRole[],
  ds: PlanDataset,
  geoHits: GeoHits = {},
  defined: DefinedMeasure[] = [],
): { matches: RoleMatch[]; missingRequired: string[] } {
  const matches: RoleMatch[] = [];
  const missingRequired: string[] = [];
  // One column plays one part: a template whose date and category both landed on
  // the same column would build two tiles of the same chart.
  const taken = new Set<string>();

  for (const role of roles) {
    // A DEFINED METRIC wins a measure role outright. The scorer below reads
    // column names, which is a guess at what the user calls their numbers; a
    // metric named "Revenue" is that same user having already answered. So a
    // template's Revenue role takes the Revenue metric's column, not whichever
    // numeric column happened to score highest.
    const named = role.kind === 'measure' ? namedMeasure(role, ds, defined, taken) : null;
    if (named) {
      taken.add(named.column);
      matches.push({ role: role.id, column: named.column, confidence: 'high', metricId: named.id });
      continue;
    }

    const scored: Scored[] = [];
    ds.columns.forEach((c) => {
      if (taken.has(c.name)) return;
      const s = scoreColumn(role, c, ds, geoHits);
      if (s) scored.push(s);
    });
    // Stable: score first, DECLARED ORDER within a score (forEach above walks
    // ds.columns in order and sort() is stable in every Node the app runs on).
    scored.sort((a, b) => b.score - a.score);
    const floor = role.kind === 'date' ? 0 : SCORE_FLOOR;
    const hit = scored.find((s) => s.score >= floor);
    if (!hit) {
      matches.push({ role: role.id, column: '', confidence: 'low' });
      if (role.required) missingRequired.push(role.label);
      continue;
    }
    taken.add(hit.column);
    const m: RoleMatch = { role: role.id, column: hit.column, confidence: confidenceOf(hit, role.kind) };
    if (hit.geoLevel) m.geoLevel = hit.geoLevel;
    matches.push(m);
  }

  return { matches, missingRequired };
}

/** The mapping as the plain `{ roleId: column }` object every factory takes. */
export function mappingOf(matches: RoleMatch[]): RoleMapping {
  const out: RoleMapping = {};
  for (const m of matches) if (m.column) out[m.role] = m.column;
  return out;
}

/** The geo level a `geo` role resolved to, by role id. */
export function geoLevelOf(matches: RoleMatch[], roleId: string): ResolvedGeoLevel | undefined {
  return matches.find((m) => m.role === roleId)?.geoLevel;
}
