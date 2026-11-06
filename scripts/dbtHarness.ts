// The dbt import suites' shared helpers (scripts/test-dbtImport.ts, scripts/test-dbtPart5.ts); not a suite.
// Fixtures: scripts/fixtures/dbt/ (f1) and scripts/fixtures/dbt-part5/ (f2), with fixed dataset ids.

import { upload } from './liveRouteHarness';
import type { ParsedColumn } from '../src/data/parse';
import type { ModelMetric } from '../src/app/modelFormat';
import type { ParsedModel } from '../src/app/modelRead';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');

export type Json = Record<string, any>; // any: a dbt manifest, edited as a test would edit one

export const F1_DIR = path.join(__dirname, 'fixtures', 'dbt');
export const P5_DIR = path.join(__dirname, 'fixtures', 'dbt-part5');
export const F1_MANIFEST: Json = JSON.parse(fs.readFileSync(path.join(F1_DIR, 'semantic_manifest.json'), 'utf8'));
export const P5: Json = JSON.parse(fs.readFileSync(path.join(P5_DIR, 'semantic_manifest.json'), 'utf8'));
export const copyOf = (j: Json): Json => JSON.parse(JSON.stringify(j));

export const ORDERS_COLUMNS: ParsedColumn[] = [
  { name: 'id', type: 'text' }, { name: 'customer_id', type: 'text' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' },
  { name: 'status', type: 'text' }, { name: 'order_date', type: 'date' }, { name: 'stock_date', type: 'date' }, { name: 'units', type: 'number' },
];
export const VISITS_COLUMNS: ParsedColumn[] = [{ name: 'visit_id', type: 'text' }, { name: 'customer_id', type: 'text' }, { name: 'visit_date', type: 'date' }];
export const ORDERS = '0d000000-0000-4000-8000-000000000001';
export const VISITS = '0d000000-0000-4000-8000-000000000002';
export const OTHER = '0d000000-0000-4000-8000-000000000003';
export const F1_DATASETS = [
  { id: ORDERS, name: 'Orders', columns: ORDERS_COLUMNS },
  { id: VISITS, name: 'visits', columns: VISITS_COLUMNS },
  { id: OTHER, name: 'Orders archive', columns: ORDERS_COLUMNS },
];

export const P5_COLUMNS: Record<'orders' | 'balances' | 'events', ParsedColumn[]> = {
  orders: [{ name: 'order_id', type: 'text' }, { name: 'customer_id', type: 'text' }, { name: 'region', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'status', type: 'text' }, { name: 'order_date', type: 'date' }],
  balances: [{ name: 'account_id', type: 'text' }, { name: 'region', type: 'text' }, { name: 'mrr', type: 'number' }, { name: 'snapshot_date', type: 'date' }],
  events: [{ name: 'user_id', type: 'text' }, { name: 'event', type: 'text' }, { name: 'ts', type: 'date' }],
};
export const P5_DATASETS = (['orders', 'balances', 'events'] as const).map((name, i) => ({ id: `0d000000-0000-4000-8000-00000000005${i}`, name, columns: P5_COLUMNS[name] }));

export const metricNamed = (model: ParsedModel, name: string): ModelMetric => model.metrics.find((m) => m.name === name) as ModelMetric;
export const allMetricNames = (manifest: Json): string[] => (manifest.metrics as Json[]).map((m) => m.label ?? m.name);
export const uploadJson = async (json: unknown): Promise<string> => (await upload(Buffer.from(JSON.stringify(json)), 'semantic_manifest.json')).fileToken;

/** A seed CSV's rows, typed by `columns` (an empty cell is null). */
export const csvRows = (file: string, columns: ParsedColumn[]): (string | number | null)[][] =>
  fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map((line) => line.split(',').map((cell, i) => (cell === '' ? null : columns[i].type === 'number' ? Number(cell) : cell)));

// ── The four kinds f1 skipped and f2 reads: cumulative, conversion, time offsets, window groupings ──
const FOUR: ReadonlySet<string> = new Set(['cumulative', 'conversion', 'time_offset', 'window_groupings']);
type Translation = { model: ParsedModel; skipped: Array<{ dbt: string; reason: string }> };

/** `t` without the skipped entries `golden` skipped for one of the four kinds (whatever `t` says of them now). */
export function withoutFourKinds<T extends Translation>(t: T, golden: Translation): T {
  const gone = new Set(golden.skipped.filter((s) => FOUR.has(s.reason)).map((s) => s.dbt));
  const keep = <S extends { dbt: string }>(list: S[]): S[] => list.filter((s) => !gone.has(s.dbt));
  const dbt = t.model.dbt ? { ...t.model.dbt, skipped: keep(t.model.dbt.skipped) } : undefined;
  return { ...t, skipped: keep(t.skipped), model: { ...t.model, ...(dbt && { dbt }) } };
}

/** `manifest` without its metrics of the four kinds, and without what is built on them. */
export function dropFourKinds(manifest: Json): Json {
  const out = copyOf(manifest);
  const measures = new Map<string, Json>((out.semantic_models as Json[]).flatMap((s) => (s.measures as Json[]).map((m) => [m.name, m] as [string, Json])));
  const grouped = (m: Json): boolean => !!measures.get(m.type_params?.measure?.name)?.non_additive_dimension?.window_groupings?.length;
  const offset = (m: Json): boolean => (m.type_params?.metrics ?? []).some((i: Json) => i.offset_window || i.offset_to_grain);
  const four = new Set((out.metrics as Json[]).filter((m) => m.type === 'cumulative' || m.type === 'conversion' || offset(m) || (m.type === 'simple' && grouped(m))).map((m) => m.name));
  const names = (m: Json): string[] => [m.type_params?.numerator?.name ?? m.type_params?.numerator, m.type_params?.denominator?.name ?? m.type_params?.denominator, ...(m.type_params?.metrics ?? []).map((i: Json) => i.name ?? i)];
  out.metrics = (out.metrics as Json[]).filter((m) => !four.has(m.name) && !names(m).some((x) => four.has(x)));
  return out;
}
