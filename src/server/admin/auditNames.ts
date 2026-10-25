// Names for the ids one page of Admin → Audit log shows. A row stores ids,
// never names (../authz/audit.ts), so names are looked up when the page is
// read: the CURRENT name, from the caller's org only — its users, its teams and
// its records (a record in Trash still has its name). An id that names nothing
// (a card or sheet inside a dashboard, a record purged from Trash) gets no entry.
//
// Two record reads at most: the projects first, then the records of the
// project each row names (its own project, or a project among its ids).

import * as path from 'path';
import type { Pool } from 'pg';
import * as recordFs from '../../app/recordFs';
import { isValidId, projectDir, RECORD_DIR, type FileRecordType } from '../../app/recordKinds';
import { trashDir } from '../../app/trashStore';

export type NamedKind = 'project' | FileRecordType | 'connection' | 'user' | 'team';

export interface Named {
  readonly kind: NamedKind;
  readonly name: string;
  /** The record is in its project's Trash. */
  readonly trashed?: true;
}

const MAX_NAME = 200;
const TYPES = Object.keys(RECORD_DIR) as FileRecordType[];

interface Spot { readonly id: string; readonly kind: NamedKind; readonly trashed?: true }

function nameIn(body: string): string | null {
  try {
    const v = JSON.parse(body) as { name?: unknown } | null;
    const name = typeof v?.name === 'string' ? v.name.trim() : '';
    return name ? name.slice(0, MAX_NAME) : null;
  } catch {
    return null; // a corrupt record is skipped, never fatal
  }
}

/** Reads every candidate file; a live record wins over a Trash copy of the same id. */
async function readInto(out: Record<string, Named>, spots: Map<string, Spot>): Promise<void> {
  if (!spots.size) return;
  const found = await recordFs.readMany([...spots.keys()]);
  for (const [file, body] of found) {
    const spot = spots.get(file);
    const name = spot && nameIn(body);
    if (!spot || !name || (out[spot.id] && !out[spot.id].trashed)) continue;
    out[spot.id] = { kind: spot.kind, name, ...(spot.trashed ? { trashed: true as const } : {}) };
  }
}

/** id → what it names, for the ids of `rows`. Runs inside the admin's request (records are the org's). */
export async function auditNames(
  pool: Pool,
  org: string,
  rows: ReadonlyArray<{ readonly projectId: string | null; readonly targets: readonly string[] }>,
): Promise<Record<string, Named>> {
  const ids = [...new Set(rows.flatMap((r) => (r.projectId ? [r.projectId, ...r.targets] : r.targets)))];
  const out: Record<string, Named> = {};
  if (!ids.length) return out;

  const [users, teams] = await Promise.all([
    pool.query<{ id: string; label: string }>('SELECT id::text AS id, email AS label FROM users WHERE org_id = $1 AND id = ANY($2::uuid[])', [org, ids]),
    pool.query<{ id: string; label: string }>('SELECT id::text AS id, name AS label FROM teams WHERE org_id = $1 AND id = ANY($2::uuid[])', [org, ids]),
  ]);
  for (const r of users.rows) out[r.id] = { kind: 'user', name: r.label };
  for (const r of teams.rows) out[r.id] = { kind: 'team', name: r.label };

  const projects = new Map<string, Spot>();
  for (const id of ids) {
    const dir = projectDir(id);
    if (dir && !out[id]) projects.set(path.join(dir, 'project.json'), { id, kind: 'project' });
  }
  await readInto(out, projects);

  const records = new Map<string, Spot>();
  for (const r of rows) {
    const pids = r.projectId ? [r.projectId] : r.targets.filter((t) => out[t]?.kind === 'project');
    for (const pid of pids) {
      const dir = projectDir(pid);
      if (!dir) continue;
      for (const id of r.targets) {
        if (out[id] || !isValidId(id)) continue;
        for (const type of TYPES) {
          records.set(path.join(dir, RECORD_DIR[type], id + '.json'), { id, kind: type });
          records.set(path.join(trashDir(pid, type), id + '.json'), { id, kind: type, trashed: true });
        }
        records.set(path.join(dir, 'connections', id + '.json'), { id, kind: 'connection' });
      }
    }
  }
  await readInto(out, records);
  return out;
}
