// Self-check for the Postgres foundation (src/server/db/, T3.1): DATABASE_URL
// validation, password scrubbing, the migration loader, and — the reason this
// file exists — that N pods starting at once apply each migration EXACTLY ONCE.
//
// The DB half needs a Postgres it may CREATE DATABASE on (CI has a service;
// locally `DATABASE_URL=postgres://you@localhost:5432/postgres`). Without
// DATABASE_URL it prints one `skip` line and runs only the pure checks, so
// `npm test` stays green on a machine with no Postgres. Every run makes its own
// scratch database and drops it.
//
//   npm run build:ts && DATABASE_URL=… node scripts/test-db-migrate.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, Pool } from 'pg';

const envMod: typeof import('../src/server/env') = require('../src/server/env');
const poolMod: typeof import('../src/server/db/pool') = require('../src/server/db/pool');
const mig: typeof import('../src/server/db/migrate') = require('../src/server/db/migrate');

const MAIN = path.join(__dirname, '..', 'src', 'server', 'main.js');
const CANARY = 'pw-L3akCanary%2Fx';
const CANARY_DECODED = 'pw-L3akCanary/x';

function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete e.ELECTRON_RUN_AS_NODE;
  return e;
}

interface Run {
  child: ChildProcess;
  /** stdout + stderr so far. */
  out: () => string;
  /** Base URL once listening, null if it exited first. */
  base: Promise<string | null>;
  exited: Promise<number | null>;
}

function startServer(databaseUrl: string, dataDir: string): Run {
  const child = spawn(process.execPath, [MAIN], {
    env: childEnv({ PORT: '0', DATA_DIR: dataDir, ORDINATE_ENV: 'dev', LOG_LEVEL: 'info', DATABASE_URL: databaseUrl }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const base = new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 30_000);
    const onData = (c: Buffer): void => {
      out += c.toString();
      const m = /"msg":"Server listening at (http:\/\/[^"]+)"/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    void exited.then(() => resolve(null));
  });
  return { child, out: () => out, base, exited };
}

/** The `applied` list from a server's "migrations current" log line. */
function appliedBy(out: string): string[] | null {
  for (const line of out.split('\n')) {
    if (!line.includes('"migrations current"')) continue;
    const o = JSON.parse(line) as { applied: string[]; ms: number };
    console.log(`     migrations current: applied ${JSON.stringify(o.applied)} in ${o.ms} ms`);
    return o.applied;
  }
  return null;
}

const tmpDir = (tag: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `ordinate-db-${tag}-`));

(async () => {
  // ── DATABASE_URL validation ───────────────────────────────────────────────
  ok('env: DATABASE_URL unset → null', envMod.parseEnv({}).databaseUrl === null);
  const good = `postgres://u:${CANARY}@db.internal:5432/ordinate`;
  ok('env: a postgres:// URL is kept as given', envMod.parseEnv({ DATABASE_URL: good }).databaseUrl === good);
  ok('env: postgresql:// is accepted', envMod.parseEnv({ DATABASE_URL: 'postgresql://h/db' }).databaseUrl === 'postgresql://h/db');
  for (const bad of [`mysql://u:${CANARY}@h/db`, `u:${CANARY}@h/db`, `http://u:${CANARY}@h`]) {
    try {
      envMod.parseEnv({ DATABASE_URL: bad });
      ok(`env: ${bad.split(':')[0]}… is rejected`, false);
    } catch (err) {
      const e = err as Error;
      ok(`env: ${bad.split(':')[0]}… is rejected naming DATABASE_URL`, e.name === 'EnvError' && e.message.includes('DATABASE_URL'), e.message);
      ok(`env: the rejection never echoes the password (${bad.split(':')[0]}…)`, !e.message.includes('L3akCanary'), e.message);
    }
  }

  // ── Password scrubbing ────────────────────────────────────────────────────
  const leaky = Object.assign(new Error(`could not connect to ${good}: pw was ${CANARY_DECODED} / ${CANARY}`), { code: '28P01' });
  const s = poolMod.scrubbed(leaky, good);
  ok('scrub: neither spelling of the password survives', !s.message.includes('L3akCanary'), s.message);
  ok('scrub: the stack does not carry the original message', !(s.stack ?? '').includes('L3akCanary'));
  ok('scrub: the pg error code is kept', (s as Error & { code?: string }).code === '28P01');
  ok('scrub: the rest of the message survives', s.message.includes('db.internal'), s.message);

  // ── Loader ────────────────────────────────────────────────────────────────
  const real = mig.loadMigrations();
  ok('loader: the shipped migrations resolve from src/server/db/migrations', real.length >= 1 && real[0].name === '0001_init.sql', real.map((m) => m.name).join());
  ok('loader: versions strictly ascend', real.every((m, i) => i === 0 || m.version > real[i - 1].version));
  const loaderFails = (label: string, files: Record<string, string>, needle: string): void => {
    const d = tmpDir('loader');
    for (const [n, body] of Object.entries(files)) fs.writeFileSync(path.join(d, n), body);
    try {
      mig.loadMigrations(d);
      ok(`loader: ${label} is refused`, false);
    } catch (err) {
      ok(`loader: ${label} is refused`, (err as Error).message.includes(needle), (err as Error).message);
    }
    fs.rmSync(d, { recursive: true, force: true });
  };
  loaderFails('an empty directory', {}, 'no migrations');
  loaderFails('a misnamed file', { '001_x.sql': 'SELECT 1' }, 'NNNN_lower_snake');
  loaderFails('a duplicate version', { '0001_a.sql': 'SELECT 1', '0001_b.sql': 'SELECT 1' }, 'share version');

  // ── Startup failure never prints the password ─────────────────────────────
  const dead = startServer(`postgres://u:${CANARY}@127.0.0.1:1/nothing`, tmpDir('dead'));
  const deadCode = await dead.exited;
  ok('dead DB: the server refuses to start (exit ≠ 0)', deadCode !== 0 && deadCode !== null, deadCode);
  ok('dead DB: the startup error names the cause', /ECONNREFUSED/.test(dead.out()), dead.out());
  ok('dead DB: the password appears nowhere in the output', !dead.out().includes('L3akCanary'), dead.out());

  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    console.log('skip DB checks: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
    return;
  }

  // ── Two pods, one fresh database ─────────────────────────────────────────
  const dbName = `ordinate_t31_${process.pid}_${Date.now()}`;
  const scratch = new URL(adminUrl);
  scratch.pathname = '/' + dbName;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const pool = new Pool({ connectionString: scratch.toString(), max: 2 });
  const runs: Run[] = [];
  try {
    const data = tmpDir('pods');
    runs.push(startServer(scratch.toString(), data), startServer(scratch.toString(), data));
    const bases = await Promise.all(runs.map((r) => r.base));
    ok('pods: both servers start and listen', bases.every((b) => b !== null), runs.map((r) => r.out()).join('\n---\n'));

    const total = real.length;
    const rows = await pool.query<{ version: number; n: string }>('SELECT version, count(*) AS n FROM schema_migrations GROUP BY version ORDER BY version');
    ok(`pods: schema_migrations holds each of the ${total} migration(s) exactly once`,
      rows.rows.length === total && rows.rows.every((r, i) => r.version === real[i].version && r.n === '1'), JSON.stringify(rows.rows));
    const lists = runs.map((r) => appliedBy(r.out()));
    ok('pods: both report the schema current', lists.every((l) => l !== null), JSON.stringify(lists));
    const sizes = lists.map((l) => l?.length ?? -1).sort();
    ok('pods: one pod applied every migration, the other applied none', sizes[0] === 0 && sizes[1] === total, JSON.stringify(lists));
    const logs = runs.map((r) => r.out()).join('\n');
    ok('pods: no duplicate-object error in either log', !/already exists|duplicate key|"level":50|"level":60/.test(logs), logs);

    for (const [i, b] of bases.entries()) {
      if (!b) continue;
      const rz = await fetch(b + '/readyz');
      const body = (await rz.json()) as { checks?: { postgres?: boolean } };
      ok(`pods: /readyz on pod ${i + 1} is 200 with postgres up`, rz.status === 200 && body.checks?.postgres === true, JSON.stringify(body));
    }
    for (const r of runs) r.child.kill('SIGTERM');
    const codes = await Promise.all(runs.map((r) => r.exited));
    ok('pods: SIGTERM closes both cleanly (exit 0)', codes.every((c) => c === 0), JSON.stringify(codes));

    // ── An edited file is refused; a new file is applied once ──────────────
    const copy = tmpDir('edit');
    for (const m of real) fs.writeFileSync(path.join(copy, m.name), m.sql);
    fs.appendFileSync(path.join(copy, '0001_init.sql'), '\n-- an innocent-looking edit\n');
    try {
      await mig.migrate(pool, copy);
      ok('edit: migrate refuses a changed applied file', false);
    } catch (err) {
      ok('edit: migrate refuses a changed applied file', (err as Error).message.includes('0001_init.sql has changed since it was applied'), (err as Error).message);
    }
    fs.writeFileSync(path.join(copy, '0001_init.sql'), real[0].sql.replace(/\n/g, '\r\n'));
    const crlf = await mig.migrate(pool, copy);
    ok('edit: CRLF line endings are not an edit', crlf.applied.length === 0, JSON.stringify(crlf));
    fs.writeFileSync(path.join(copy, '9999_probe.sql'), 'CREATE TABLE t31_probe (id int);');
    const first = await mig.migrate(pool, copy);
    const again = await mig.migrate(pool, copy);
    ok('new file: applied once, then nothing', first.applied.join() === '9999_probe.sql' && again.applied.length === 0, JSON.stringify([first, again]));
    console.log(`     one-file apply in-process: ${first.ms.toFixed(1)} ms; no-op run: ${again.ms.toFixed(1)} ms`);
    // A new file numbered BELOW one already applied (9999 now) is refused, nothing applied.
    fs.writeFileSync(path.join(copy, '9000_late.sql'), 'CREATE TABLE t31_late (id int);');
    try {
      await mig.migrate(pool, copy);
      ok('order: a new file numbered below an applied one is refused', false);
    } catch (err) {
      ok('order: a new file numbered below an applied one is refused, naming it', /9000_late\.sql is new but numbered below 9999/.test((err as Error).message), (err as Error).message);
    }
    ok('order: …and nothing of it ran', (await pool.query(`SELECT to_regclass('t31_late') AS t`)).rows[0].t === null);
    fs.rmSync(copy, { recursive: true, force: true });

    // ── The real server refuses to start on an edited migration ─────────────
    await pool.query(`UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = 1`);
    const edited = startServer(scratch.toString(), data);
    const code = await edited.exited;
    ok('edit: the server refuses to start (exit ≠ 0)', code !== 0 && code !== null, code);
    ok('edit: the log names the changed migration', edited.out().includes('0001_init.sql has changed since it was applied'), edited.out());
    ok('edit: it never listened', !edited.out().includes('Server listening'), edited.out());
    fs.rmSync(data, { recursive: true, force: true });
  } finally {
    for (const r of runs) if (r.child.exitCode === null) r.child.kill('SIGKILL');
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
})()
  .catch((err) => ok('suite ran to completion', false, err instanceof Error ? err.stack : err))
  .finally(finish);
