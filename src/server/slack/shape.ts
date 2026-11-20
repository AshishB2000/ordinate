// What leaves the app goes through the project's Share policy, and a Slack post leaves it (`slack` is a share path,
// src/app/privacyStore.ts). `applyToChart` / `applyToTable` run on the card before it is posted, in a channel or a
// direct message. Anything masked or dropped → the caller replaces the model's sentence, which could quote a raw value,
// with a fixed caption.

import { applyToChart, applyToTable, sensitiveColumns } from '../../app/sharePolicy';
import { getPolicy } from '../../app/privacyStore';
import { specEncoding } from '../../ai/answerJoin';
import type { ParsedColumn } from '../../data/parse';
import type { Card } from './ask';

export interface Shaped { card: Card | null; changed: boolean }

type Cell = string | number | null;

/** The card as the share policy lets it leave; `changed`: something was masked, or the whole card was held back. */
export async function shape(projectId: string, card: Card | null, datasetIds: readonly string[]): Promise<Shaped> {
  if (!card) return { card: null, changed: false };
  if (card.kind === 'sql') return shapeSql(projectId, card, datasetIds);
  const spec = card.spec;
  if (!spec || typeof spec.datasetId !== 'string' || !card.data) return { card, changed: false };
  const out = await applyToChart(projectId, spec.datasetId, specEncoding(spec), { ok: true, data: { labels: card.data.labels, series: card.data.series } }, 'slack');
  if (!out.ok) return { card: null, changed: true }; // drop, a map, or no masking key: held back whole
  const moved = JSON.stringify(out.data.labels) !== JSON.stringify(card.data.labels) || JSON.stringify(out.data.series) !== JSON.stringify(card.data.series);
  return { card: moved ? { ...card, data: { ...card.data, labels: out.data.labels, series: out.data.series } } : card, changed: moved };
}

/** An SQL answer's table: shaped for every dataset it read whose marked columns the result names. */
async function shapeSql(projectId: string, card: Card, datasetIds: readonly string[]): Promise<Shaped> {
  let columns = card.columns as ParsedColumn[];
  let rows = card.rows as Cell[][];
  let changed = false;
  for (const id of datasetIds) {
    const marked = await sensitiveColumns(projectId, id);
    if (![...marked.keys()].some((m) => columns.some((c) => c.name === m))) {
      // Not named in the result: but the statement may have RENAMED it (`customer AS c`). A marked column the statement names and
      // the result does not is withheld whole: the table cannot be told apart from a masked one, and fails closed.
      const sql = typeof card.sql === 'string' ? card.sql.toLowerCase() : '';
      if (sql && [...marked.keys()].some((m) => new RegExp(`\\b${m.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(sql)) && (await policyActs(projectId))) return { card: null, changed: true };
      continue;
    }
    const t = await applyToTable(projectId, id, { columns, rows }, 'slack');
    columns = t.columns;
    rows = t.rows as Cell[][];
    changed = changed || t.masked.length > 0 || t.dropped.length > 0;
  }
  return changed ? { card: { ...card, columns, rows, chart: undefined }, changed } : { card, changed };
}

/** Does the project's `slack` share path act on marked columns at all (anything but `include`)? */
const policyActs = async (projectId: string): Promise<boolean> => (await getPolicy(projectId)).slack !== 'include';
