// What SQL names each dataset by (../engine/sqlNames `assignViewNames`: its id, name and creation time), off ONE listing
// of the project's dataset records — the paged query `listDatasets` reads (../app/recordFs `listRecords`) — and no read
// of a record per dataset. The Query tab's gate (../engine/sqlDatasets `compile`) resolves a statement's tables by it,
// then reads the records of only the datasets the statement names.

import * as recordFs from '../app/recordFs';
import { isValidId } from '../app/ids';
import { datasetsDir } from './datasetRecord';
import { isValidDataset, normalize } from './datasets';

export interface DatasetName { id: string; name: string; createdAt: string }

/** Every dataset of the project as `listDatasets` lists them (a corrupt or stray record skipped), by name only. */
export async function listDatasetNames(projectId: string): Promise<DatasetName[]> {
  if (!isValidId(projectId)) return [];
  let records;
  try {
    records = await recordFs.listRecords(datasetsDir(projectId));
  } catch (_) {
    return []; // no datasets yet
  }
  const out: DatasetName[] = [];
  for await (const r of records) {
    if (!isValidId(r.name.slice(0, -'.json'.length))) continue; // a stray or temp file
    try {
      const d: unknown = JSON.parse(r.text());
      if (!isValidDataset(d)) continue;
      const ds = normalize(d, projectId); // the name and creation time getDatasetMeta reads
      out.push({ id: ds.id, name: ds.name, createdAt: ds.createdAt });
    } catch (_) { /* corrupt or gone since the listing: listDatasets skips it too (and logs it) */ }
  }
  return out;
}
