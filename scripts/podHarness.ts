// Real server processes for the multi-pod suites (test-anyPod, test-sharedCounters)
// — a helper, not a suite. Each pod is `node [-r preload] src/server/main.js` on
// PORT=0 with its own environment; a scratch database is created and dropped.

import { spawn, type ChildProcess } from 'child_process';
import { withCsrf } from './csrfPair';

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { Client, Pool }: typeof import('pg') = require('pg');
const wire: typeof import('../src/server/wire') = require('../src/server/wire');

const MAIN = path.join(__dirname, '..', 'src', 'server', 'main.js');

export interface Pod {
  readonly base: string;
  readonly child: ChildProcess;
  /** Everything the pod wrote to stdout and stderr so far. */
  out(): string;
  err(): string;
  /** Pino lines of stdout, parsed. */
  lines(): Array<Record<string, unknown>>;
  alive(): boolean;
  stop(): Promise<void>;
}

const pods = new Set<Pod>();

export const tmp = (name: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `ordinate-${name}-`));

/** A server process. `preload` is a script `-r`-loaded first. Resolves once it listens. */
export function startPod(env: Record<string, string>, preload?: string): Promise<Pod> {
  const args = preload ? ['-r', preload, MAIN] : [MAIN];
  const child = spawn(process.execPath, args, {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PORT: '0', ORDINATE_ENV: 'dev', LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let exited = false;
  child.stdout?.on('data', (c: Buffer) => (out += c.toString()));
  child.stderr?.on('data', (c: Buffer) => (err += c.toString()));
  child.on('exit', () => { exited = true; });
  return new Promise<Pod>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`pod did not start: ${err || out}`.slice(0, 800))), 40_000);
    const onData = (): void => {
      const m = /"msg":"Server listening at (http:\/\/[^"]+)"/.exec(out);
      if (!m) return;
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      const pod: Pod = {
        base: m[1],
        child,
        out: () => out,
        err: () => err,
        lines: () => out.split('\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return {}; } }),
        alive: () => !exited,
        stop: () => new Promise<void>((r) => {
          pods.delete(pod);
          if (exited) return r();
          child.once('exit', () => r());
          child.kill();
        }),
      };
      pods.add(pod);
      resolve(pod);
    };
    child.stdout?.on('data', onData);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`pod exited ${code}: ${err}`.slice(0, 800))); });
  });
}

export async function stopAll(): Promise<void> {
  await Promise.all([...pods].map((p) => p.stop()));
}

export type Who = Record<string, string>;

/** One RPC. `who` is the identity headers (x-test-user, x-forwarded-email, …); `client` the tab id. */
export async function rpc(base: string, who: Who, channel: string, payload?: unknown, client?: string): Promise<{ status: number; body: any }> { // any: each channel's own reply
  const res = await fetch(`${base}/api/rpc/${channel}`, {
    method: 'POST',
    headers: withCsrf({ 'content-type': 'application/json', ...who, ...(client ? { 'x-ordinate-client': client } : {}) }),
    body: wire.encode({ args: payload === undefined ? [] : [payload] }),
  });
  const text = await res.text();
  return { status: res.status, body: res.status === 200 ? wire.decode(text) : text };
}

/** POST /api/files: the token, or the status when refused. */
export async function upload(base: string, who: Who, bytes: Buffer, name: string): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)]), name);
  const res = await fetch(`${base}/api/files`, { method: 'POST', body: form, headers: withCsrf(who) });
  if (res.status !== 200) throw new Error(`upload refused: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { fileToken: string }).fileToken;
}

/** GET /api/files/<token>: the bytes, or null on a refusal. */
export async function download(base: string, who: Who, token: string): Promise<Buffer | null> {
  const res = await fetch(`${base}/api/files/${token}`, { headers: who });
  if (res.status !== 200) {
    await res.body?.cancel();
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

export interface Scratch {
  readonly url: string;
  readonly pool: import('pg').Pool;
  drop(): Promise<void>;
}

/** A fresh database on DATABASE_URL's server (migrations are the pods' own), or null without one. */
export async function scratchDb(tag: string): Promise<Scratch | null> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) return null;
  const name = `ordinate_${tag}_${process.pid}_${Date.now()}`;
  const u = new URL(adminUrl);
  u.pathname = '/' + name;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const pool = new Pool({ connectionString: u.toString(), max: 8 });
  pool.on('error', () => undefined); // an idle client cut by the DROP … WITH (FORCE) teardown
  return {
    url: u.toString(),
    pool,
    async drop() {
      await pool.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it is truthy or `ms` pass; the last value. */
export async function until<T>(fn: () => Promise<T> | T, ms: number, every = 100): Promise<T> {
  const end = Date.now() + ms;
  let v = await fn();
  while (!v && Date.now() < end) {
    await sleep(every);
    v = await fn();
  }
  return v;
}
