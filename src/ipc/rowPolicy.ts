// Row access rules, managed (docs/row-policy/00-design.md D3) — MAIN PROCESS.
//
//   dataset:rowPolicy      the Row access tab: the rules, whether they still
//                          hold (the column, the pipeline, the column's writers),
//                          and the datasets built from this one
//   dataset:setRowPolicy   save or remove them; the server stamps `stepsHash`
//
// Both are project ADMIN channels (src/api/rowPolicy.ts). The rules are read and
// written RAW on the record — never through the in-memory Dataset — with the
// record's lock (`serialized`), the same lock a data write's record write takes
// (datasetRecord.writeRecordKeepingPolicy), so neither overwrites the other.

import type { Pool } from 'pg';
import { ipcMain } from './bus';
import { ctx } from '../server/context';
import * as datasets from '../data/datasets';
import * as recordFs from '../app/recordFs';
import { isValidId } from '../app/ids';
import { datasetFilePath, serialized } from '../data/datasetRecord';
import { sanitizeSteps } from '../data/transforms';
import { parseRules, policyFromRecord, ruleState, textColumn, writersHash, type RowPolicy, type RuleState } from '../data/rowPolicy';
import { parentsOfRecord, upstreamIds } from '../data/upstream';
import { rulesChanged } from '../data/rowAccess';
import * as msg from '../data/rowAccessMessages';

// ponytail: one pool per process, like authz/share.ts — set by register().
let poolOf: () => Pool | null = () => null;

async function readRaw(projectId: string, id: string): Promise<Record<string, unknown> | null> {
  try {
    const raw: unknown = JSON.parse(await recordFs.readFile(datasetFilePath(projectId, id), 'utf8'));
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The datasets of the project built from `id`, at any depth (D14): closed to viewers until they have rules of their own. */
async function builtFrom(projectId: string, id: string): Promise<{ id: string; name: string }[]> {
  const out: { id: string; name: string }[] = [];
  const parents = async (p: string): Promise<string[]> => (isValidId(p) ? parentsOfRecord(await readRaw(projectId, p)) : []);
  for (const d of await datasets.listDatasets(projectId)) {
    if (d.id === id) continue;
    if ((await upstreamIds(d.id, parents)).ids.has(id)) out.push({ id: d.id, name: d.name });
  }
  return out;
}

/** Every user and team a rule names must be one of this org's. */
async function membersExist(pool: Pool, rules: RowPolicy['rules']): Promise<boolean> {
  const org = ctx().org.id;
  const users = [...new Set(rules.map((r) => r.userId).filter((x): x is string => !!x))];
  const teams = [...new Set(rules.map((r) => r.teamId).filter((x): x is string => !!x))];
  if (users.length) {
    const r = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users WHERE org_id = $1 AND id = ANY($2::uuid[])', [org, users]);
    if ((r.rows[0]?.n ?? 0) !== users.length) return false;
  }
  if (teams.length) {
    const r = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM teams WHERE org_id = $1 AND id = ANY($2::uuid[])', [org, teams]);
    if ((r.rows[0]?.n ?? 0) !== teams.length) return false;
  }
  return true;
}

const PROBLEM: Record<string, () => string> = { column: msg.rowBadColumnMessage, rules: msg.rowBadValuesMessage, member: msg.rowUnknownMemberMessage, values: msg.rowBadValuesMessage, value: msg.rowBadValuesMessage };

export function register(pool: () => Pool | null): void {
  poolOf = pool;

  ipcMain.handle('dataset:rowPolicy', async (_e, { projectId, datasetId }: { projectId: string; datasetId: string }) => {
    if (!poolOf()) return { ok: false as const, code: 'no_database', error: msg.rowNeedsDatabaseMessage() };
    const raw = await readRaw(projectId, datasetId);
    if (!raw) return { ok: false as const, error: 'Dataset not found' };
    const policy = policyFromRecord(raw);
    return {
      ok: true as const,
      policy: policy ? { column: policy.column, rules: policy.rules } : null,
      state: policy ? ruleState(raw, policy) : ('ok' as RuleState),
      builtFrom: await builtFrom(projectId, datasetId),
    };
  });

  ipcMain.handle('dataset:setRowPolicy', async (_e, { projectId, datasetId, policy }: { projectId: string; datasetId: string; policy: { column: string; rules: unknown[] } | null }) => {
    const db = poolOf();
    if (!db) return { ok: false as const, code: 'no_database', error: msg.rowNeedsDatabaseMessage() };
    const file = datasetFilePath(projectId, datasetId);
    rulesChanged(projectId); // before and after: a check that started meanwhile is not remembered past this save
    try {
      return await saveRules(db, file, policy);
    } finally {
      rulesChanged(projectId);
    }
  });
}

/** Save or remove a dataset's rules (the record's lock holds the check and the stamp). */
async function saveRules(db: Pool, file: string, policy: { column: string; rules: unknown[] } | null) {
  if (policy === null) {
    const done = await serialized(file, (raw) => {
      delete raw.rowPolicy;
      return true;
    });
    return done ? { ok: true as const, policy: null } : { ok: false as const, error: 'Dataset not found' };
  }
  const parsed = parseRules(policy.column, policy.rules);
  if (!parsed.ok) return { ok: false as const, error: PROBLEM[parsed.problem]() };
  if (!(await membersExist(db, parsed.rules))) return { ok: false as const, error: msg.rowUnknownMemberMessage() };
  // Checked and stamped under the record's lock, against the record as it is at that moment.
  const res = await serialized(file, (raw): 'saved' | 'column' => {
    if (!textColumn(raw, parsed.column)) return 'column';
    raw.rowPolicy = { column: parsed.column, rules: parsed.rules, stepsHash: writersHash(sanitizeSteps(raw.steps), parsed.column) };
    return 'saved';
  });
  if (res === false) return { ok: false as const, error: 'Dataset not found' };
  if (res === 'column') return { ok: false as const, error: msg.rowBadColumnMessage() };
  return { ok: true as const, policy: { column: parsed.column, rules: parsed.rules } };
}
