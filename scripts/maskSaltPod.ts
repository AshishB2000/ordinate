// One "pod" for scripts/test-maskSalt-db.ts: a fresh process on its own
// DATA_DIR, the shared database, and a hash step over fixed values.
//
//   node scripts/maskSaltPod.js <store|nostore> <dataDir> <databaseUrl> <masterKey> <org> <projectId>
//
// `store` wires the secrets store as app.ts does; `nostore` leaves the salt on
// this process's disk (the server without ORDINATE_MASTER_KEY). Prints one JSON
// line: { tokens, threw, saltFile } — never the salt itself.

export {}; // module scope — sibling scripts share top-level names
import * as fs from 'fs';
import { Pool } from 'pg';

const [mode, dataDir, dbUrl, masterKey, org, pid] = process.argv.slice(2);
const VALUES = ['ana@example.com', 'bo@example.com', ''];

(async () => {
  const context: typeof import('../src/server/context') = require('../src/server/context');
  const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
  const privacy: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
  const secrets: typeof import('../src/server/secrets/store') = require('../src/server/secrets/store');
  const { parseMasterKey }: typeof import('../src/server/env') = require('../src/server/env');
  const { applyMaskStep }: typeof import('../src/data/maskSteps') = require('../src/data/maskSteps');
  context.enterServerMode(dataDir);
  const pool = new Pool({ connectionString: dbUrl, max: 2 });
  recordFs.useRecordDb(pool);
  privacy.useMaskSaltStore(mode === 'store' ? secrets.createSecretStore(pool, parseMasterKey('key', masterKey)) : null);
  const who = { user: { email: 'pod@t', role: 'admin' as const }, org: { id: org } };
  const out = await context.runInContext(who, 'pod', async () => {
    const steps = [{ type: 'mask_hash' as const, column: 'email' }];
    let tokens: unknown = null;
    let threw: string | null = null;
    try {
      const salt = await privacy.saltForSteps(pid, steps);
      const t = applyMaskStep({ columns: [{ name: 'email', type: 'text' }], rows: VALUES.map((v) => [v]) } as never, steps[0], { salt });
      tokens = (t.table.rows as unknown[][]).map((r) => r[0]);
    } catch (err) {
      threw = (err as Error).name;
    }
    return { tokens, threw, saltFile: fs.existsSync(privacy.saltPath(pid)) };
  });
  recordFs.useRecordDb(null);
  await pool.end();
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
})().catch((err) => {
  process.stderr.write(String(err && (err as Error).stack) + '\n');
  process.exit(1);
});
