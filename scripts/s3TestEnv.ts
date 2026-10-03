// Shared setup for the S3 storage self-checks (T5.2): a scratch Postgres
// database with every migration applied, and a bucket + a prefix unique to
// this run on the S3 store STORAGE_URL names (MinIO locally and in CI).
//
// Needs, in the environment: STORAGE_URL=s3://bucket[/prefix], DATABASE_URL
// (a Postgres this may CREATE DATABASE on), the store's credentials through
// the chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY for MinIO), S3_ENDPOINT
// for MinIO, and DUCKDB_EXTENSION_DIR with httpfs + aws installed
// (`node scripts/duckdb-extensions.js`). Without STORAGE_URL=s3 or
// DATABASE_URL, `setup()` returns the reason to skip instead.

const path: typeof import('path') = require('path');
const { Client, Pool }: typeof import('pg') = require('pg');

export interface S3Test {
  readonly s3: import('../src/server/env').S3Env;
  readonly pool: import('pg').Pool;
  /** Every key this run registered is deleted, then the scratch DB dropped. */
  teardown(): Promise<void>;
}

export async function setup(tag: string): Promise<S3Test | string> {
  const envMod: typeof import('../src/server/env') = require('../src/server/env');
  const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');
  const s3: typeof import('../src/engine/s3') = require('../src/engine/s3');
  const adminUrl = process.env.DATABASE_URL ?? '';
  if (!(process.env.STORAGE_URL ?? '').startsWith('s3://')) return 'STORAGE_URL is not s3://…';
  if (!adminUrl) return 'DATABASE_URL is unset';
  if (!process.env.DUCKDB_EXTENSION_DIR) {
    process.env.DUCKDB_EXTENSION_DIR = path.resolve(__dirname, '..', '.duckdb-extensions');
  }
  const run = `${tag}-${process.pid}-${Date.now()}`;
  const base = envMod.parseEnv(process.env).storage.s3!;
  const cfg = Object.freeze({ ...base, prefix: base.prefix ? `${base.prefix}/${run}` : run });
  await s3.createBucket(cfg);

  const dbName = `ordinate_t52_${tag.replace(/\W/g, '_')}_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: u.toString(), max: 4 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  await mig.migrate(pool);
  return {
    s3: cfg,
    pool,
    async teardown() {
      try {
        const keys = await pool.query('SELECT org_id, key FROM storage_objects');
        for (const r of keys.rows as Array<{ org_id: string; key: string }>) {
          await s3.remove(cfg, `${cfg.prefix}/orgs/${r.org_id}/${r.key}`).catch(() => undefined);
        }
      } finally {
        await pool.end().catch(() => undefined);
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
        await admin.end();
      }
    },
  };
}
