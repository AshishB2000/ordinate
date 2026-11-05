// Column access rules, managed (semantic layer part 4, D12–D14, D22, D23) — MAIN PROCESS.
//
//   dataset:columnAccess      the Access tab's "Who sees each column": the rules (carriers with `from`),
//                             whether they still hold, the marked columns not hidden yet, and the datasets
//                             built from this one (closed to whom a column is hidden from)
//   dataset:setColumnAccess   save or remove them; the server adds the carriers and stamps `readersHash`,
//                             `updatedBy` and `updatedAt`
//
// Both are project ADMIN channels (src/api/columnAccess.ts), the twins of ./rowPolicy.ts. The rules are read
// and written RAW on the record, under the record's lock (`serialized`), the same lock a data write's record
// write takes (datasetRecord.writeRecordKeepingPolicy, which keeps `columnAccess`), so neither overwrites the
// other. Nothing is stored on a refusal.

import type { Pool } from 'pg';
import { ipcMain } from './bus';
import { osUser } from '../app/catalog';
import { markedColumns } from '../app/sharePolicy';
import { datasetFilePath, serialized } from '../data/datasetRecord';
import { MAX_RULED_COLUMNS, accessState, buildColumnAccess, columnAccessFromRecord, widerCarrier, type ColumnRule, type Member } from '../data/columnAccess';
import { rulesChanged } from '../data/rowAccess';
import { rowUnknownMemberMessage } from '../data/rowAccessMessages';
import * as msg from '../data/columnAccessMessages';
import { builtFrom, membersExist, readRaw } from './rowPolicy';

let poolOf: () => Pool | null = () => null;

const NOT_FOUND = { ok: false as const, error: 'Dataset not found' };
const lower = (m: Member): Member => ('userId' in m ? { userId: m.userId.toLowerCase() } : { teamId: m.teamId.toLowerCase() });

export function register(pool: () => Pool | null): void {
  poolOf = pool;

  ipcMain.handle('dataset:columnAccess', async (_e, { projectId, datasetId }: { projectId: string; datasetId: string }) => {
    if (!poolOf()) return { ok: false as const, code: 'no_database', error: msg.columnNeedsDatabase() };
    const raw = await readRaw(projectId, datasetId);
    if (!raw) return NOT_FOUND;
    const access = columnAccessFromRecord(raw);
    const rules = access && access !== 'closed' ? access.columns : [];
    const hidden = new Set(rules.map((r) => r.column));
    return {
      ok: true as const,
      rules,
      // 'closed': stored rules that do not sanitize (every restricted caller is refused until they are saved again).
      state: access === null ? ('none' as const) : access === 'closed' ? ('closed' as const) : accessState(raw, access),
      suggest: (await markedColumns(projectId, datasetId)).map((m) => m.column).filter((c) => !hidden.has(c)),
      builtFrom: await builtFrom(projectId, datasetId),
    };
  });

  ipcMain.handle('dataset:setColumnAccess', async (_e, { projectId, datasetId, columns }: { projectId: string; datasetId: string; columns: Array<{ column: string; visibleTo: Member[] }> | null }) => {
    const db = poolOf();
    if (!db) return { ok: false as const, code: 'no_database', error: msg.columnNeedsDatabase() };
    rulesChanged(projectId); // before and after: a check that started meanwhile is not remembered past this save
    try {
      return await saveRules(db, datasetFilePath(projectId, datasetId), columns);
    } finally {
      rulesChanged(projectId);
    }
  });
}

type Saved = { ok: true; rules: ColumnRule[] } | { ok: false; error: string };

async function saveRules(db: Pool, file: string, columns: Array<{ column: string; visibleTo: Member[] }> | null): Promise<Saved> {
  if (!columns || !columns.length) {
    const done = await serialized(file, (raw) => {
      delete raw.columnAccess;
      return true;
    });
    return done ? { ok: true, rules: [] } : NOT_FOUND;
  }
  const rules = columns.map((c) => ({ column: c.column, visibleTo: c.visibleTo.map(lower) }));
  const twice = rules.find((r, i) => rules.findIndex((x) => x.column === r.column) !== i);
  if (twice) return { ok: false, error: msg.columnTwice(twice.column) };
  if (!(await membersExist(db, rules.flatMap((r) => r.visibleTo)))) return { ok: false, error: rowUnknownMemberMessage() };
  // Checked and stamped under the record's lock, against the record as it is at that moment.
  const res = await serialized(file, (raw): Saved => {
    const has = new Set((Array.isArray(raw.columns) ? raw.columns : []).map((c: { name?: unknown }) => c?.name));
    const lacks = rules.find((r) => !has.has(r.column));
    if (lacks) return { ok: false, error: msg.columnNotInDataset(lacks.column) };
    const wider = widerCarrier(raw, rules);
    if (wider) return { ok: false, error: msg.carrierWider(wider.column, wider.from) };
    const built = buildColumnAccess(raw, rules, osUser(), new Date().toISOString()); // stamped as late as it can be: just before the write
    if (built.columns.length > MAX_RULED_COLUMNS) return { ok: false, error: msg.tooManyColumns(String(MAX_RULED_COLUMNS)) };
    raw.columnAccess = built;
    return { ok: true, rules: built.columns };
  });
  return res === false ? NOT_FOUND : res;
}
