// Self-check for `npm run import-desktop` (src/server/importDesktop.ts, T5.1).
//
// The round trip: seed the bundled sample project in a desktop userData (the
// real seeder, desktop mode), run the importer as the operator would — a
// child process with DATABASE_URL and DATA_DIR — TWICE, then boot the server
// against that database and ask over RPC. projects:list and dataset:list must
// equal what the desktop handlers returned; every record must read back
// byte-equal to its source file; every Parquet file must have the same row
// count; and the second run must change nothing. With ORDINATE_MASTER_KEY an
// Image-card picture becomes a `blobs` row and the project's masking key one
// encrypted secret that hashes Object.is-equal to the desktop's — CONTROL: a
// run with no key copies the salt.key file instead.
//
// Without DATABASE_URL it prints one `skip` line.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-importDesktop.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { withCsrf } from './csrfPair';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';
import { Client, Pool } from 'pg';
import { randomBytes } from 'crypto';

const REPO = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinate-import-'));
const DESKTOP = path.join(TMP, 'desktop-userData');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DESKTOP);
fs.mkdirSync(DATA);

process.env.ORDINATE_LOCAL_DIR = DESKTOP;

const ORG = 'acme';
const KEY = randomBytes(32).toString('base64');

// The search index is written beside the Parquet on a 1.5 s timer after the
// seed — between the two imports when the machine is slow, which would make
// the second run copy one more file. A cache, not part of the round trip.
(require('../src/engine/dataSearchResident') as { scheduleIndex: () => void }).scheduleIndex = () => undefined;

/** Every file under `dir`, '/'-relative, sorted. */
function walk(dir: string, rel = '', out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(dir, r, out);
    else out.push(r);
  }
  return out.sort();
}

function importer(url: string, dataDir = DATA, key: string | null = KEY): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(REPO, 'src/server/importDesktop.js'), DESKTOP, '--org', ORG],
      { env: { ...process.env, DATABASE_URL: url, DATA_DIR: dataDir, ORDINATE_ENV: 'dev', ...(key ? { ORDINATE_MASTER_KEY: key } : {}) } },
      (e, out, err) => resolve({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, out: out + err }));
  });
}

(async () => {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }
  const appMod: typeof import('../src/server/app') = require('../src/server/app');
  const envMod: typeof import('../src/server/env') = require('../src/server/env');
  const wire: typeof import('../src/server/wire') = require('../src/server/wire');
  const rpc: typeof import('../src/server/rpc') = require('../src/server/rpc');
  const context: typeof import('../src/server/context') = require('../src/server/context');
  const recordFs: typeof import('../src/app/recordFs') = require('../src/app/recordFs');
  const duck: typeof import('../src/engine/duckdb') = require('../src/engine/duckdb');
  const projects: typeof import('../src/app/projects') = require('../src/app/projects');
  const sample: typeof import('../src/app/sampleProject') = require('../src/app/sampleProject');
  const themes: typeof import('../src/app/themeStore') = require('../src/app/themeStore');
  const privacy: typeof import('../src/app/privacyStore') = require('../src/app/privacyStore');
  const assets: typeof import('../src/app/projectAssets') = require('../src/app/projectAssets');
  const { maskToken }: typeof import('../src/data/maskSteps') = require('../src/data/maskSteps');

  // ── The desktop install, and what its handlers answer ────────────────────
  appMod.registerHandlers();
  await projects.init();
  const seeded = await sample.seedSampleProject();
  await themes.saveTheme({ name: 'Brand', tokens: { '--bg': '#ffffff' } });
  ok('desktop: the sample project is seeded', seeded.seeded && !!seeded.projectId);
  // A picture and a masking key, as the desktop keeps them: files.
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
  fs.writeFileSync(path.join(TMP, 'pic.png'), PNG);
  const pic = await assets.importImage(seeded.projectId!, path.join(TMP, 'pic.png'));
  const picRel = 'id' in pic ? `projects/${seeded.projectId}/assets/${pic.id}.png` : '';
  const desktopSalt = await privacy.getSalt(seeded.projectId!);
  ok('desktop: a picture and a masking key on disk', !!picRel && fs.existsSync(path.join(DESKTOP, picRel)) && fs.existsSync(privacy.saltPath(seeded.projectId!)));
  const call = async (ch: string, payload?: unknown): Promise<unknown> => rpc.handlers.get(ch)!(null, payload);
  const wantProjects = await call('projects:list');
  const pids = (wantProjects as Array<{ id: string }>).map((p) => p.id);
  const wantDatasets: Record<string, unknown> = {};
  for (const id of pids) wantDatasets[id] = await call('dataset:list', { projectId: id });
  const files = walk(DESKTOP).filter((r) => /^(projects|history|templates)\/|^themes\.json$/.test(r));
  const recordFiles = files.filter(recordFs.isRecordPath);
  const parquet = files.filter((r) => r.endsWith('.parquet'));
  ok(`desktop: ${recordFiles.length} record files and ${parquet.length} Parquet files to import`, recordFiles.length >= 5 && parquet.length >= 1);

  // ── Import twice into a scratch database ─────────────────────────────────
  const dbName = `ordinate_t51i_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + dbName;
  const url = u.toString();
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: url, max: 2 });
  pool.on('error', () => undefined); // an idle client cut by the DROP DATABASE … WITH (FORCE) teardown
  const rows = async (): Promise<Array<{ path: string; body: string }>> =>
    (await pool.query('SELECT path, body FROM records WHERE org_id = $1 ORDER BY path', [ORG])).rows;
  try {
    const t0 = performance.now();
    const r1 = await importer(url);
    const ms = performance.now() - t0;
    ok('import: exits 0 and says what it loaded', r1.code === 0 && /imported into org acme \(Postgres\): 1 projects, \d+ records/.test(r1.out), r1.out);
    console.log(`  import of the sample: ${ms.toFixed(0)} ms (child process incl. Node start + migrate)`);
    const first = await rows();
    ok(`import: one row per record file (${first.length})`, first.length === recordFiles.length,
      JSON.stringify({ rows: first.map((r) => r.path), files: recordFiles }));
    const r2 = await importer(url);
    const second = await rows();
    ok('import: a second run succeeds and changes nothing (idempotent)', r2.code === 0 && r2.out === r1.out && isDeepStrictEqual(first, second), r2.out);
    const orgDisk = walk(path.join(DATA, 'orgs', ORG, 'userData'));
    ok('import: no record file was written to the org\'s disk — records are rows', !orgDisk.some(recordFs.isRecordPath), orgDisk.filter(recordFs.isRecordPath).join());
    const blobRows = (await pool.query<{ path: string; bytes: Buffer }>('SELECT path, bytes FROM blobs WHERE org_id = $1', [ORG])).rows;
    ok('import: the picture is a blobs row, byte-equal, and not on the org\'s disk',
      blobRows.length === 1 && blobRows[0].path === picRel && blobRows[0].bytes.equals(PNG) && !orgDisk.includes(picRel), JSON.stringify(blobRows.map((r) => r.path)));
    const saltRows = async (): Promise<string[]> =>
      (await pool.query<{ c: string }>(`SELECT encode(ciphertext, 'hex') AS c FROM secrets WHERE org_id = $1 AND kind = 'privacy.salt'`, [ORG])).rows.map((r) => r.c);
    const sealedSalt = await saltRows();
    ok('import: the masking key is one encrypted secret, and no salt.key on the org\'s disk', sealedSalt.length === 1 && !orgDisk.some((r) => r.endsWith('salt.key')), orgDisk.filter((r) => r.endsWith('salt.key')).join());
    const DATA2 = path.join(TMP, 'data-nokey');
    const r3 = await importer(url, DATA2, null);
    const copied = path.join(DATA2, 'orgs', ORG, 'userData', 'projects', seeded.projectId!, 'privacy', 'salt.key');
    ok('CONTROL: a run with no master key copies the salt.key file, and the stored secret is untouched',
      r3.code === 0 && fs.existsSync(copied) && fs.readFileSync(copied, 'utf8') === desktopSalt && JSON.stringify(await saltRows()) === JSON.stringify(sealedSalt), r3.out);

    // ── The server, over RPC ────────────────────────────────────────────────
    context.enterServerMode(DATA);
    const who = { user: { email: 'a@acme', role: 'admin' as const }, org: { id: ORG } };
    const app = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: url, ORDINATE_MASTER_KEY: KEY }), undefined, () => who);
    await app.ready();
    try {
      const post = async (channel: string, payload?: unknown): Promise<unknown> => {
        const res = await app.inject({ method: 'POST', url: `/api/rpc/${channel}`, headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: payload === undefined ? [] : [payload] }) });
        if (res.statusCode !== 200) throw new Error(`${channel}: ${res.statusCode} ${res.body}`);
        return wire.decode(res.body);
      };
      const gotProjects = await post('projects:list');
      ok('rpc: projects:list equals the desktop\'s', isDeepStrictEqual(gotProjects, wantProjects), JSON.stringify({ gotProjects, wantProjects }).slice(0, 2000));
      for (const id of pids) {
        const got = await post('dataset:list', { projectId: id });
        ok(`rpc: dataset:list equals the desktop's (${(got as unknown[]).length} datasets)`, isDeepStrictEqual(got, wantDatasets[id]) && (got as unknown[]).length > 0,
          JSON.stringify({ got, want: wantDatasets[id] }).slice(0, 2000));
      }
      const mismatched = await context.runInContext(who, 'check', async () => {
        const bad: string[] = [];
        for (const rel of recordFiles) {
          const want = fs.readFileSync(path.join(DESKTOP, rel), 'utf8');
          const got = await recordFs.readFile(path.join(DATA, 'orgs', ORG, 'userData', rel), 'utf8').catch(() => null);
          if (got !== want) bad.push(rel);
        }
        return bad;
      });
      ok(`records: all ${recordFiles.length} read back byte-equal to their source files`, mismatched.length === 0, mismatched.join());
      const steps = [{ type: 'mask_hash' as const, column: 'email' }];
      const serverSalt = await context.runInContext(who, 'salt', () => privacy.saltForSteps(seeded.projectId!, steps));
      ok('salt: the server hashes Object.is-equal to the desktop', Object.is(maskToken(serverSalt!, 'ana@example.com'), maskToken(desktopSalt!, 'ana@example.com')));
      const shown = await post('asset:read', { projectId: seeded.projectId, id: 'id' in pic ? pic.id : '', ext: 'png' }) as { dataUrl?: string };
      ok('rpc: asset:read serves the imported picture from its row', shown.dataUrl === 'data:image/png;base64,' + PNG.toString('base64'));
      const count = async (p: string): Promise<number> =>
        Number((await duck.queryAsync(`SELECT count(*) AS n FROM read_parquet('${p.replace(/'/g, "''")}')`))[0].n);
      for (const rel of parquet) {
        const a = await count(path.join(DESKTOP, rel));
        const b = await count(path.join(DATA, 'orgs', ORG, 'userData', rel));
        ok(`parquet: ${path.basename(rel)} — ${b} rows, equal to the source`, a === b && a > 0, `${a} vs ${b}`);
      }
      const other = appMod.buildApp(envMod.parseEnv({ AUTH_MODE: 'dev', LOG_LEVEL: 'silent', DATA_DIR: DATA, DATABASE_URL: url }), undefined, () => ({ ...who, org: { id: 'someone-else' } }));
      await other.ready();
      const res = await other.inject({ method: 'POST', url: '/api/rpc/projects:list', headers: withCsrf({ 'content-type': 'application/json' }), payload: wire.encode({ args: [] }) });
      ok('rpc: another org lists nothing of it', res.statusCode === 200 && isDeepStrictEqual(wire.decode(res.body), []), res.body);
      await other.close();
    } finally {
      await app.close();
    }
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    finish();
  });
