'use strict';

// An event funnel computed IN PLACE off the stored Parquet — the resident twin
// of `analysis/funnelEvents.buildEventFunnel`'s matching pass.
//
// The entry is a WINDOW — `row_number() OVER (PARTITION BY entity ORDER BY t,
// ordinal)` picks each entity's first step-1 event, and with it the breakdown
// value that entity is counted under. Each later step is the earliest event of
// that name strictly after the previous match, kept only inside the window;
// the time gaps' two middle values come from a second window over the gaps.
// What comes back is GROUPS — counts per breakdown label, middle gaps per step
// — and `funnelEvents.foldEventFunnel` does every division on both paths.
//
// Standing rules: the entity keys on its DECLARED type, the breakdown label on
// its DECLARED type, every aggregate is `CAST(… AS DOUBLE)`, empty is null OR
// '' OR whitespace. A timestamp is read by `funnelEvents.TS_RE`, the same text
// the JS path compiles. An event-name column typed `number` DECLINES (null):
// JS matches `String(cell)` and SQL's own float formatting is not that.

import type { FilterStep } from '../data/transforms';
import type { EventFunnel, FunnelEncoding, FunnelGroups } from '../analysis/funnelEvents';
import { TS_RE, foldEventFunnel, funnelNeeds, windowMs } from '../analysis/funnelEvents';
import { filterPredicates, runOrderedAsync } from './residentQuery';
import type { ResidentSource } from './residentQuery';
import { bomSafe, phys, sqlNum } from './residentCategory';
import { entityKeySql } from './cohortResident';
import type * as duck from './duckdb';

const TS_PARTS = ['y', 'mo', 'd', 'h', 'mi', 's', 'f'];

/** `funnelEvents.eventMs` over the named-group struct `ts` — BIGINT epoch ms, or NULL. */
function msFromParts(ts: string): string {
  const part = (k: string): string => `coalesce(TRY_CAST(nullif(${ts}.${k}, '') AS BIGINT), 0)`;
  const date = `TRY_CAST(nullif(${ts}.y, '') || '-' || ${ts}.mo || '-' || ${ts}.d AS DATE)`;
  return `CASE WHEN ${part('h')} <= 23 AND ${part('mi')} <= 59 AND ${part('s')} <= 59 THEN ` +
    `CAST(date_diff('day', DATE '1970-01-01', ${date}) AS BIGINT) * 86400000 + ${part('h')} * 3600000 + ` +
    `${part('mi')} * 60000 + ${part('s')} * 1000 + CAST(left(${ts}.f || '000', 3) AS BIGINT) END`;
}

const num = (raw: duck.DuckValue): number => (typeof raw === 'number' ? raw : Number(raw));

/** Counts per breakdown label, middle gaps per step, and the excluded count — or null. */
export async function funnelGroupsResident(
  src: ResidentSource,
  enc: FunnelEncoding,
  filters?: FilterStep[],
): Promise<FunnelGroups | null> {
  try {
    const cols = Array.isArray(src.columns) ? src.columns : [];
    if (funnelNeeds(cols, enc)) return null;
    const idx = (name: string): number => cols.findIndex((c) => c && c.name === name);
    const ei = idx(enc.entity);
    const ni = idx(enc.event);
    const ti = idx(enc.time);
    const bi = enc.breakdown ? idx(enc.breakdown) : -1;
    if (cols[ni].type === 'number') return null;
    const numDim = bi >= 0 && cols[bi].type === 'number';
    const dim = bi < 0 ? 'CAST(NULL AS VARCHAR)' : numDim ? sqlNum(phys(bi)) : bomSafe(phys(bi));
    const S = enc.steps.length;
    const W = windowMs(enc.window);
    const tsText = `CAST(${phys(ti)} AS VARCHAR)`;
    const names = [...new Set(enc.steps)];

    // Params are positional, pushed in STATEMENT-TEXT order: the filters (in
    // `raw`), the step-name IN list, step 1's name, then per later step the
    // window bound followed by that step's name.
    const params: duck.DuckValue[] = [];
    const preds = filterPredicates(cols, filters, params);
    const where = preds.length ? ` WHERE ${preds.join(' AND ')}` : '';
    for (const n of names) params.push(n);
    params.push(enc.steps[0]);
    let chain = '';
    for (let k = 1; k < S; k += 1) {
      params.push(W, enc.steps[k]);
      chain += `, s${k} AS (SELECT * EXCLUDE (r), CASE WHEN r - m0 <= ? THEN r END AS m${k} FROM ` +
        `(SELECT s${k - 1}.*, (SELECT min(ev.t) FROM ev WHERE ev.e = s${k - 1}.e AND ev.n = ? ` +
        `AND ev.t > s${k - 1}.m${k - 1}) AS r FROM s${k - 1}))`;
    }
    const withSql = (from: string, ord: string): string =>
      `WITH raw AS (SELECT ${ord} AS o, ${entityKeySql(phys(ei), cols[ei].type === 'number')} AS e, ` +
      `CAST(${phys(ni)} AS VARCHAR) AS n, regexp_extract(${tsText}, '${TS_RE}', ` +
      `[${TS_PARTS.map((p) => `'${p}'`).join(', ')}]) AS ts, ${dim} AS d FROM ${from}${where}), ` +
      `base AS (SELECT o, e, n, d, ${msFromParts('ts')} AS t FROM raw), ` +
      `ev AS (SELECT o, e, n, t, d FROM base WHERE e IS NOT NULL AND t IS NOT NULL ` +
      `AND n IN (${names.map(() => '?').join(', ')})), ` +
      `s0 AS (SELECT e, t AS m0, d, o AS o0 FROM (SELECT e, t, d, o, ` +
      `row_number() OVER (PARTITION BY e ORDER BY t, o) AS rn FROM ev WHERE n = ?) WHERE rn = 1)` +
      chain + ' ';
    const lastS = `s${S - 1}`;

    const counts = Array.from({ length: S }, (_, k) => `CAST(count(m${k}) AS DOUBLE) AS c${k}`).join(', ');
    const groupRows = await runOrderedAsync(src.parquetPath, (from, ord) =>
      withSql(from, ord) + `SELECT d AS g, CAST(min(o0) AS DOUBLE) AS first, ${counts} FROM ${lastS} GROUP BY d;`,
    params);

    const gaps = Array.from({ length: S - 1 }, (_, i) =>
      `SELECT ${i + 1} AS k, m${i + 1} - m${i} AS dt FROM ${lastS} WHERE m${i + 1} IS NOT NULL`).join(' UNION ALL ');
    const midRows = await runOrderedAsync(src.parquetPath, (from, ord) =>
      withSql(from, ord) +
      `, gaps AS (${gaps}), ` +
      `med AS (SELECT k, dt, row_number() OVER (PARTITION BY k ORDER BY dt) AS rn, ` +
      `count(*) OVER (PARTITION BY k) AS cnt FROM gaps) ` +
      `SELECT CAST(k AS DOUBLE) AS k, CAST(min(dt) AS DOUBLE) AS lo, CAST(max(dt) AS DOUBLE) AS hi FROM med ` +
      `WHERE rn = (cnt + 1) // 2 OR rn = cnt // 2 + 1 GROUP BY k;`, params);

    const meta = await runOrderedAsync(src.parquetPath, (from, ord) =>
      withSql(from, ord) +
      `SELECT CAST(count(*) AS DOUBLE) AS total, ` +
      `CAST(sum(CASE WHEN e IS NOT NULL AND t IS NOT NULL THEN 1 ELSE 0 END) AS DOUBLE) AS kept FROM base;`, params);

    const mids: Array<[number, number] | null> = enc.steps.map(() => null);
    for (const r of midRows) {
      const k = num(r.k);
      if (k >= 1 && k < S) mids[k] = [num(r.lo), num(r.hi)];
    }
    const m = meta[0] || {};
    return {
      groups: groupRows.map((r) => ({
        label: r.g == null ? '' : numDim ? String(num(r.g)) : String(r.g),
        counts: Array.from({ length: S }, (_, k) => num(r[`c${k}`])),
        first: num(r.first),
      })),
      mids,
      excluded: num(m.total ?? 0) - num(m.kept ?? 0),
    };
  } catch {
    return null;
  }
}

/** The whole resident answer, folded — or null to run `funnelEvents.buildEventFunnel`. */
export async function eventFunnelResident(src: ResidentSource, enc: FunnelEncoding, filters?: FilterStep[]): Promise<EventFunnel | null> {
  const groups = await funnelGroupsResident(src, enc, filters);
  return groups ? foldEventFunnel(enc, groups) : null;
}
