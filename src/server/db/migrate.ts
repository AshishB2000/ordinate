// Schema migrations: plain numbered .sql files, applied at startup.
//
// N pods start together on a rollout, so every pod runs this and exactly one
// does the work: the whole run is ONE transaction that first takes a
// transaction-scoped advisory lock. The other pods block on the lock, then
// find every version already recorded and apply nothing. If the leader dies
// mid-run its transaction rolls back and the lock is released with its
// connection, so the next pod starts from a clean slate.
//
// Files: `migrations/NNNN_name.sql`, applied in version order, each recorded
// in `schema_migrations` with a sha256 of its text. A recorded migration whose
// file no longer hashes the same refuses startup — an applied migration is
// history; change the schema with a new file. 0001_init.sql creates
// `schema_migrations` itself, so the runner reads "no table" as "nothing applied".
//
// RUNTIME PATH. The .sql files are not compiled; they are read from
// `<dir of this module>/migrations`. tsc emits this module in place
// (src/server/db/migrate.js), so in dev, under `npm test` and `npm run server`
// that is src/server/db/migrations/ — the files as committed. A Docker image
// (T7.1) must copy them beside the emitted .js: `COPY src/ src/` after
// `npm run build:ts` does it; a build that copies only `**/*.js` would boot
// with zero migrations, which `loadMigrations` refuses rather than starting on
// an empty schema.
//
// ponytail: one transaction for the whole run, so a migration cannot use
// statements Postgres forbids in a transaction (CREATE INDEX CONCURRENTLY,
// ALTER TYPE … ADD VALUE before PG12). Add a per-file "no transaction" marker
// the first time one is needed.

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { Pool } from 'pg';

export const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/** Fixed key for `pg_advisory_xact_lock` — any constant int8 no other code uses. */
const LOCK_KEY = '7310452291';

const NAME_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrateResult {
  /** File names applied by THIS call, in order (empty when another pod got there first). */
  readonly applied: readonly string[];
  /** Total migrations on disk, all of which are now recorded. */
  readonly total: number;
  /** Wall time including the wait for the lock. */
  readonly ms: number;
}

// CRLF → LF before hashing: a Windows checkout with autocrlf must not read as an edit.
const checksumOf = (sql: string): string => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql'));
  if (files.length === 0) throw new Error(`no migrations found in ${dir}`);
  const out = files.map((name): Migration => {
    const m = NAME_RE.exec(name);
    if (!m) throw new Error(`migration file ${name} must be named NNNN_lower_snake.sql`);
    const sql = fs.readFileSync(path.join(dir, name), 'utf8');
    return { version: Number(m[1]), name, sql, checksum: checksumOf(sql) };
  });
  out.sort((a, b) => a.version - b.version);
  for (let i = 1; i < out.length; i++) {
    if (out[i].version === out[i - 1].version) throw new Error(`two migrations share version ${out[i].version}: ${out[i - 1].name}, ${out[i].name}`);
  }
  return out;
}

export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<MigrateResult> {
  const t0 = performance.now();
  const migrations = loadMigrations(dir);
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);

    const exists = await client.query<{ t: string | null }>(`SELECT to_regclass('schema_migrations')::text AS t`);
    const done = new Map<number, { name: string; checksum: string }>();
    if (exists.rows[0].t !== null) {
      const rows = await client.query<{ version: number; name: string; checksum: string }>('SELECT version, name, checksum FROM schema_migrations');
      for (const r of rows.rows) done.set(r.version, r);
    }

    for (const m of migrations) {
      const prior = done.get(m.version);
      if (prior && prior.checksum !== m.checksum) {
        throw new Error(
          `migration ${m.name} has changed since it was applied (recorded ${prior.checksum.slice(0, 12)}, file ${m.checksum.slice(0, 12)}); ` +
            'restore the file and put the change in a new migration',
        );
      }
    }
    // A NEW file numbered below one already applied would run out of order
    // here (parallel branches each taking "the next" number) — and in order
    // on a fresh database, so the two would disagree. Refuse it: renumber.
    const highest = Math.max(0, ...done.keys());
    const late = migrations.find((m) => !done.has(m.version) && m.version < highest);
    if (late) {
      throw new Error(
        `migration ${late.name} is new but numbered below ${String(highest).padStart(4, '0')}, already applied here; ` +
          `it would run out of order — renumber it above ${String(highest).padStart(4, '0')}`,
      );
    }
    for (const m of migrations) {
      if (done.has(m.version)) continue;
      await client.query(m.sql);
      await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [m.version, m.name, m.checksum]);
      applied.push(m.name);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  return { applied, total: migrations.length, ms: performance.now() - t0 };
}
