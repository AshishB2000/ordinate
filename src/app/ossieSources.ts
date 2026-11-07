// What the Ossie export reads besides the model files (semantic layer part 7, g1): the warehouse table of each Live
// dataset the caller may open, and each dataset's declared columns. Metadata only, never a row; the connection's
// values, SQL and secrets are read nowhere here (only liveSourceOf's table parts).

import * as datasets from '../data/datasets';
import * as connections from '../connectors/connections';
import { getConnector } from '../connectors';
import { isLive } from '../data/liveDataset';
import { liveSourceOf } from '../engine/live/liveTarget';
import { seesSourceNames } from '../data/sourceNames';
import { declaredColumns } from '../data/liveCalcs';

export interface OssieInputs {
  /** dataset id → warehouse table, only for a Live dataset over a table whose connection the caller can open. */
  sources: Map<string, string>;
  /** dataset id → the columns its source holds: a Live dataset's calculated fields are not among them (`calcs`). */
  columns: Map<string, { name: string; type: 'text' | 'number' | 'date' }[]>;
  /** dataset id → a Live dataset's calculated field names. */
  calcs: Map<string, string[]>;
}

export async function ossieInputs(projectId: string): Promise<OssieInputs> {
  const out: OssieInputs = { sources: new Map(), columns: new Map(), calcs: new Map() };
  const may = await seesSourceNames(projectId);
  for (const d of await datasets.listDatasets(projectId)) {
    const meta = await datasets.getDatasetMeta(projectId, d.id);
    if (!meta) continue;
    out.columns.set(d.id, declaredColumns(meta).map((c) => ({ name: c.name, type: c.type })));
    if (meta.live?.calculated?.length) out.calcs.set(d.id, meta.live.calculated.map((c) => c.name));
    const origin = meta.origin;
    if (!may || !isLive(meta) || !meta.live || origin?.kind !== 'connection') continue;
    const conn = await connections.getConnection(projectId, origin.connId);
    const def = conn && getConnector(conn.connectorId);
    if (!def?.live) continue;
    const src = liveSourceOf(origin, def, def.live.dialect);
    if (src?.kind === 'table') out.sources.set(d.id, src.parts.join('.'));
  }
  return out;
}
