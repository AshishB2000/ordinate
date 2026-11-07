// A BigQuery `tables.get` reply → the table's facts (docs/semantic-layer/02-source-tables.md, D6). Pure.
// UNVERIFIED: written from BigQuery's documented Table resource and fixture-tested, never read off a
// real warehouse. numRows, numBytes and lastModifiedTime arrive as strings (int64s), so they are parsed
// strictly. BigQuery's primary key is informational (`enforced: false`). The door sanitizes the result.

import { describeColumns, prop } from './bigqueryShape';
import type { FactColumn, TableFacts } from './tableFacts';

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
const words = (v: unknown): string => (typeof v === 'string' ? v : '');

/** An int64 BigQuery sent as a string (or a number): a safe whole number, else nothing. */
function count(v: unknown): number | undefined {
  const n = typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function partitionOf(json: unknown): TableFacts['partition'] {
  const time = prop(json, 'timePartitioning');
  const range = prop(json, 'rangePartitioning');
  if (!time && !range) return undefined;
  const required = prop(json, 'requirePartitionFilter') ?? prop(time, 'requirePartitionFilter'); // the older spelling sits under timePartitioning
  const out: NonNullable<TableFacts['partition']> = range
    ? { columns: [words(prop(range, 'field'))], method: 'RANGE' }
    : { columns: [words(prop(time, 'field')) || '_PARTITIONTIME'], method: words(prop(time, 'type')) };
  if (typeof required === 'boolean') out.required = required;
  return out;
}

export function bigqueryFacts(json: unknown): TableFacts {
  const key = list(prop(prop(prop(json, 'tableConstraints'), 'primaryKey'), 'columns'));
  const described = new Map<string, string>();
  const fields = prop(prop(json, 'schema'), 'fields');
  for (const f of Array.isArray(fields) ? fields : []) described.set(words(prop(f, 'name')), words(prop(f, 'description')));
  const columns: FactColumn[] = describeColumns(json).map((c) => {
    const col: FactColumn = { ...c };
    if (described.get(c.name)) col.comment = described.get(c.name);
    if (key.includes(c.name)) col.key = true;
    return col;
  });
  const out: TableFacts = { columns };
  if (words(prop(json, 'description'))) out.comment = words(prop(json, 'description'));
  if (key.length) out.primaryKey = { columns: key, enforced: false };
  const partition = partitionOf(json);
  if (partition) out.partition = partition;
  const cluster = list(prop(prop(json, 'clustering'), 'fields'));
  if (cluster.length) out.clusterBy = cluster;
  const [rows, bytes] = [count(prop(json, 'numRows')), count(prop(json, 'numBytes'))];
  if (rows !== undefined) out.rowEstimate = rows;
  if (bytes !== undefined) out.bytes = bytes;
  const modified = new Date(count(prop(json, 'lastModifiedTime')) ?? NaN); // epoch MILLISECONDS (epochToIso reads seconds)
  if (!Number.isNaN(modified.getTime())) out.lastModified = modified.toISOString();
  return out;
}
