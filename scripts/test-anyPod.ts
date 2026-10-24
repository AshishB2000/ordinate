// Any pod can serve any request (docs/any-pod/00-design.md §6) — TWO REAL SERVER
// PROCESSES on one Postgres, every request alternating between pod A and pod B.
//
// Three passes:
//   file    A and B share one DATA_DIR (file mode)
//   s3      own DATA_DIRs, STORAGE_URL on MinIO (skipped, one line, without STORAGE_URL=s3://)
//   memory  NEGATIVE CONTROL: no DATABASE_URL, a shared DATA_DIR — the in-process stores
//
// The cases live in ./anyPodCases.ts; this file runs them per pass. Dev auth,
// with the caller read from x-test-user / x-test-org (scripts/anyPodPreload.ts),
// so two users are both admins and only a token's own user check refuses one.
//
//   npm run build:ts && DATABASE_URL=… [STORAGE_URL=s3://… S3_ENDPOINT=… AWS_…] node scripts/test-anyPod.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as H from './podHarness';
import * as C from './anyPodCases';

const path: typeof import('path') = require('path');
const envMod: typeof import('../src/server/env') = require('../src/server/env');
const s3: typeof import('../src/engine/s3') = require('../src/engine/s3');

const PRELOAD = path.join(__dirname, 'anyPodPreload.js');
const BASE_ENV = {
  AUTH_MODE: 'dev', ANYPOD_IDENTITY: '1', ANYPOD_FAST_RUNNER: '1', ANYPOD_OFFER_LOG: '1', ANYPOD_TAKE_LOG: '1', ANYPOD_POOL_PROBE: '1',
  RATE_LIMIT_RPC_PER_MINUTE: '100000', RATE_LIMIT_RPC_IP_PER_MINUTE: '100000', RATE_LIMIT_LOGIN_PER_MINUTE: '100000',
};

/** The S3 settings for this run (a prefix of its own), or why there are none. */
async function s3Env(): Promise<{ env: Record<string, string>; cfg: import('../src/server/env').S3Env } | string> {
  const url = process.env.STORAGE_URL ?? '';
  if (!url.startsWith('s3://')) return 'STORAGE_URL is not s3://…';
  const run = `anypod-${process.pid}-${Date.now()}`;
  const storage = `${url.replace(/\/+$/, '')}/${run}`;
  const env: Record<string, string> = { STORAGE_URL: storage };
  for (const k of ['S3_ENDPOINT', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'DUCKDB_EXTENSION_DIR']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  env.DUCKDB_EXTENSION_DIR ??= path.resolve(__dirname, '..', '.duckdb-extensions');
  const cfg = envMod.parseEnv({ ...process.env, ...env } as NodeJS.ProcessEnv).storage.s3!;
  await s3.createBucket(cfg);
  return { env, cfg };
}

async function pass(name: 'file' | 's3', storage: { env: Record<string, string>; cfg: import('../src/server/env').S3Env } | null): Promise<void> {
  const db = await H.scratchDb(`anypod_${name}`);
  if (!db) return;
  try {
    const shared = H.tmp(`anypod-${name}`);
    const dirA = name === 'file' ? shared : H.tmp('anypod-a');
    const dirB = name === 'file' ? shared : H.tmp('anypod-b');
    // 8 s: long enough that a case racing a held job (the sweep in 12, a second Next in 4) wins under load.
    const env = { ...BASE_ENV, ...(storage?.env ?? {}), DATABASE_URL: db.url, ANYPOD_SLOW_JOBS: 'restore,sql-save', ANYPOD_SLOW_MS: '8000' };
    const A = await H.startPod({ ...env, DATA_DIR: dirA }, PRELOAD);
    const B = await H.startPod({ ...env, DATA_DIR: dirB }, PRELOAD);
    await C.seedMembers(db.pool);
    const p: C.Pass = { name, A, B, db, dataDir: { A: dirA, B: dirB }, s3: storage?.cfg ?? null, startPod: (extra, dir) => H.startPod({ ...env, ...extra, DATA_DIR: dir ?? dirA }, PRELOAD) };
    for (const c of C.CASES) {
      try {
        await c(p);
      } catch (err) {
        ok(`[${name}] ${c.name} ran to the end`, false, err instanceof Error ? err.stack : err);
      }
    }
    for (const pod of [A, B]) ok(`[${name}] pod ${pod === A ? 'A' : 'B'} never died, and logged no uncaught error`, pod.alive() && !/uncaught|unhandled/i.test(pod.err()), pod.err().slice(-600));
  } finally {
    await H.stopAll();
    await db.drop();
  }
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('skip any-pod file and s3 passes: DATABASE_URL is unset (set it to a Postgres this suite may CREATE DATABASE on)');
  } else {
    await pass('file', null);
    const st = await s3Env();
    if (typeof st === 'string') console.log(`skip any-pod s3 pass: ${st}`);
    else await pass('s3', st);
  }
  // NEGATIVE CONTROL: the in-process stores — no database — do not cross pods.
  try {
    const dir = H.tmp('anypod-memory');
    const env = { ...BASE_ENV, DATA_DIR: dir, ANYPOD_SLOW_JOBS: 'sql-save' };
    const A = await H.startPod(env, PRELOAD);
    const B = await H.startPod(env, PRELOAD);
    await C.memoryControl(A, B);
  } finally {
    await H.stopAll();
  }
  finish();
})().catch((err) => {
  ok('the suite ran to the end', false, err instanceof Error ? err.stack : err);
  void H.stopAll().then(finish);
});
