// The server under test: the BUILT entry point (`node src/server/main.js`,
// what `npm run server` runs) on a throwaway DATA_DIR that already holds the
// sample project. Needs `npm run build:ts` and `npm --prefix web run build`.
//
// `extraEnv` is for specs that need another mode (T3.2's auth spec sets
// AUTH_MODE and friends); the default is dev auth, which signs every request
// in as dev@local.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const MAIN = path.join(REPO, 'src', 'server', 'main.js');
const SEED = fileURLToPath(new URL('./seed.ts', import.meta.url));

export interface Server {
  /** http://127.0.0.1:<port> */
  readonly base: string;
  readonly dataDir: string;
  /** What the seed made. `large`: the 1M-row dataset in the sample project, when asked for. */
  readonly sample: {
    readonly projectId: string;
    readonly projectName: string;
    readonly large?: { readonly datasetId: string; readonly rows: number; readonly ms: number };
  };
  /** Everything the server printed — attach to a failure. */
  log(): string;
  stop(): Promise<void>;
}

export interface SeedOptions {
  /** Also seed a 1,000,000-row dataset (seed.ts --large). */
  readonly large?: boolean;
}

export async function startServer(extraEnv: Record<string, string> = {}, seedOpts: SeedOptions = {}): Promise<Server> {
  for (const f of [MAIN, path.join(REPO, 'web', 'dist', 'index.html')]) {
    if (!existsSync(f)) throw new Error(`${path.relative(REPO, f)} is missing: run npm run build:ts && npm --prefix web run build`);
  }
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'ordinate-e2e-'));
  const seed = spawnSync(process.execPath, [SEED, dataDir, ...(seedOpts.large ? ['--large'] : [])], { encoding: 'utf8', timeout: 120_000 });
  if (seed.status !== 0) throw new Error(`seeding the sample project failed:\n${seed.stderr || seed.stdout}`);
  const sample = JSON.parse(seed.stdout.trim().split('\n').pop() ?? '{}') as Server['sample'];

  const child = spawn(process.execPath, [MAIN], {
    cwd: REPO,
    // DATABASE_URL is NOT inherited: a spec that wants Postgres creates its own scratch database
    // and passes it in extraEnv. Inheriting it pointed every spec at one shared database.
    env: { ...process.env, DATABASE_URL: '', PORT: '0', DATA_DIR: dataDir, ORDINATE_ENV: 'dev', LOG_LEVEL: 'info', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not listen within 30 s:\n${out}`)), 30_000);
    const onData = (c: Buffer) => {
      out += c.toString();
      const m = /"msg":"Server listening at (http:\/\/[^"]+)"/.exec(out);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${code}) before listening:\n${out}`));
    });
  });

  return {
    base,
    dataDir,
    sample,
    log: () => out,
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill('SIGTERM');
        await exited;
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
