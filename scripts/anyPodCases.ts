// The cases of scripts/test-anyPod.ts — a helper, not a suite. Each takes a
// pass (two pods on one database, file or S3 storage) and asserts with `ok`.
// Numbers are the design's (docs/any-pod/00-design.md §6).

import { createHash, randomBytes } from 'crypto';
import { ok } from './selfcheck';
import * as H from './podHarness';

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const s3: typeof import('../src/engine/s3') = require('../src/engine/s3');

export interface Pass {
  readonly name: 'file' | 's3';
  readonly A: H.Pod;
  readonly B: H.Pod;
  readonly db: H.Scratch;
  readonly dataDir: { A: string; B: string };
  readonly s3: import('../src/server/env').S3Env | null;
  /** Another pod on this pass's database and storage, with extra env (a preload switch). */
  startPod(extra: Record<string, string>, dataDir?: string): Promise<H.Pod>;
}

export const U1 = { 'x-test-user': 'u1@acme.test', 'x-test-org': 'acme' };
export const U2 = { 'x-test-user': 'u2@acme.test', 'x-test-org': 'acme' };
export const G1 = { 'x-test-user': 'g1@globex.test', 'x-test-org': 'globex' };
export const TOKEN_GONE = 'This file has expired or was already used. Upload it again.';

export const GEO = Buffer.from(JSON.stringify({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { name: 'North' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } }],
}));
export const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const hashOf = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();

/** The members the dev identities name (a creator's grant needs a users row): two in acme, one in globex. */
export async function seedMembers(pool: import('pg').Pool): Promise<void> {
  await pool.query(`INSERT INTO orgs (id, name) VALUES ('acme', 'acme'), ('globex', 'globex') ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO users (org_id, email, role, last_login_at) VALUES
    ('acme', 'u1@acme.test', 'admin', now()), ('acme', 'u2@acme.test', 'admin', now()), ('globex', 'g1@globex.test', 'admin', now())
    ON CONFLICT DO NOTHING`);
}

const projects = new Map<string, string>();
/** One project per pass and org, made on first use. */
export async function projectOf(p: { A: H.Pod }, who: Record<string, string>): Promise<string> {
  const k = p.A.base + who['x-test-org'];
  if (!projects.has(k)) projects.set(k, (await H.rpc(p.A.base, who, 'projects:create', { name: 'Any pod ' + who['x-test-org'] })).body.id as string);
  return projects.get(k) as string;
}

/** The composer's Save of a staged import (`dataset:composeSave`, what the web's import does). */
export const saveStaged = (pod: H.Pod, who: Record<string, string>, projectId: string, name: string, stagedId: string) =>
  H.rpc(pod.base, who, 'dataset:composeSave', { projectId, name, base: { inline: { name, stagedId } }, joins: [], steps: [] });

const importGeo = async (pod: H.Pod, who: Record<string, string>, projectId: string, fileToken: string) =>
  (await H.rpc(pod.base, who, 'boundary:import', { projectId, fileToken })).body as { ok: boolean; error?: string };

/** The bytes of a token's staging place: a file (file mode) or an object (S3). */
async function bytesExist(p: Pass, org: string, key: string): Promise<boolean> {
  if (!p.s3) return fs.existsSync(path.join(p.dataDir.A, 'orgs', org, 'temp', key));
  return s3.open(p.s3, `${p.s3.prefix}/orgs/${org}/staging/${key}`).then(async (o) => { o.body.destroy(); return true; }, () => false);
}
const rowOf = async (p: Pass, token: string) =>
  (await p.db.pool.query<{ storage_key: string; used_at: Date | null }>('SELECT storage_key, used_at FROM file_tokens WHERE token_hash = $1', [hashOf(token)])).rows[0] ?? null;

/** Makes `shared:sweep` due for `org` now, and waits until a pod has run it. */
async function runSweep(p: Pass, org: string): Promise<boolean> {
  const t0 = new Date();
  await p.db.pool.query(`UPDATE jobs SET next_run_at = now() WHERE kind = 'shared:sweep' AND org_id = $1`, [org]);
  return !!(await H.until(async () => (await p.db.pool.query(`SELECT 1 FROM jobs WHERE kind = 'shared:sweep' AND org_id = $1 AND last_finished_at > $2`, [org, t0])).rows.length, 15_000));
}

// ── 6. Two takes at once: exactly one wins (and the negative control) ──────
async function race(p: Pass, A: H.Pod, B: H.Pod): Promise<{ won: number; waited: boolean }> {
  const pid = await projectOf(p, U1);
  const tok = await H.upload(A.base, U1, GEO, 'race.geojson');
  const side = await p.db.pool.connect();
  try {
    await side.query('BEGIN');
    await side.query('SELECT 1 FROM file_tokens WHERE token_hash = $1 FOR UPDATE', [hashOf(tok)]);
    const fired = [importGeo(A, U1, pid, tok), importGeo(B, U1, pid, tok)];
    const waited = !!(await H.until(async () => Number((await p.db.pool.query(
      `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`)).rows[0].n) >= 2, 15_000));
    await side.query('COMMIT');
    await Promise.all(fired);
    await H.sleep(200); // the last log lines
    const hex = hashOf(tok).toString('hex');
    // Takes that won, as each pod logged them (the preload) — not import replies: with a broken take
    // both win, and then one import can still lose the race for the file the other deleted.
    const won = [A, B].reduce((n, pod) => n + pod.lines().filter((l) => l.msg === 'anypod:took' && l.hash === hex).length, 0);
    return { won, waited };
  } finally {
    side.release();
  }
}

export async function takeRace(p: Pass): Promise<void> {
  const real = await race(p, p.A, p.B);
  ok(`[${p.name}] 6: two takes of one token at once, on A and B, held at the row lock then released: exactly one wins`, real.waited && real.won === 1, JSON.stringify(real));
  if (p.name !== 'file') return;
  const C = await p.startPod({ ANYPOD_NONATOMIC_TAKE: '1' });
  const D = await p.startPod({ ANYPOD_NONATOMIC_TAKE: '1' });
  const broken = await race(p, C, D);
  ok('[file] 6: NEGATIVE CONTROL — a take that reads, then writes, lets both through the same race', broken.waited && broken.won === 2, JSON.stringify(broken));
  await C.stop();
  await D.stop();
}

// ── 7. A wrong user's take does not burn the owner's token ─────────────────
export async function wrongUser(p: Pass): Promise<void> {
  const pid = await projectOf(p, U1);
  const tok = await H.upload(p.A.base, U1, GEO, 'mine.geojson');
  const theirs = await importGeo(p.B, U2, pid, tok);
  const mine = await importGeo(p.A, U1, pid, tok);
  ok(`[${p.name}] 7: another user's take on B is refused, and the owner's take on A then works (control)`, theirs.error === TOKEN_GONE && mine.ok === true, JSON.stringify([theirs, mine]));
}

// ── 8. An expired token fails on both pods; the sweep removes its bytes ────
export async function expired(p: Pass): Promise<void> {
  const pid = await projectOf(p, U1);
  const tok = await H.upload(p.A.base, U1, GEO, 'old.geojson');
  const key = (await rowOf(p, tok))?.storage_key ?? '';
  await p.db.pool.query(`UPDATE file_tokens SET expires_at = now() - interval '1 day' WHERE token_hash = $1`, [hashOf(tok)]);
  const [a, b] = [await importGeo(p.A, U1, pid, tok), await importGeo(p.B, U1, pid, tok)];
  ok(`[${p.name}] 8: an expired token is refused on A and on B`, a.error === TOKEN_GONE && b.error === TOKEN_GONE, JSON.stringify([a, b]));
  const before = await bytesExist(p, 'acme', key);
  const swept = await runSweep(p, 'acme');
  ok(`[${p.name}] 8: …the sweep then deletes its row and its bytes (control: they were there)`, before && swept && !(await rowOf(p, tok)) && !(await bytesExist(p, 'acme', key)), JSON.stringify({ before, swept, key }));
}

// ── 12. The sweep spares a taken token while its handler still runs ──────
export async function sweepSparesTaken(p: Pass): Promise<void> {
  const backup = await H.rpc(p.B.base, U1, 'backups:download');
  const zip = backup.body?.ok ? await H.download(p.A.base, U1, backup.body.downloadToken) : null;
  if (!zip) return ok(`[${p.name}] 12: a backup to restore`, false, JSON.stringify(backup.body));
  const tok = await H.upload(p.A.base, U1, zip, 'backup.zip');
  const key = (await rowOf(p, tok))?.storage_key ?? '';
  const restoring = H.rpc(p.B.base, U1, 'backups:restore', { fileToken: tok, confirm: 'restore' }); // the preload holds the restore job ~4 s
  await H.until(async () => !!(await rowOf(p, tok))?.used_at, 5_000);
  await p.db.pool.query(`UPDATE file_tokens SET expires_at = now() - interval '1 day' WHERE token_hash = $1`, [hashOf(tok)]);
  const swept = await runSweep(p, 'acme');
  const kept = !!(await rowOf(p, tok)) && (await bytesExist(p, 'acme', key));
  const r = await restoring;
  const gone = await H.until(async () => !(await rowOf(p, tok)) && !(await bytesExist(p, 'acme', key)), 5_000);
  ok(`[${p.name}] 12: a token taken by a running restore survives the sweep (row and bytes), then done() removes both`, swept && kept && r.body?.ok === true && gone, JSON.stringify({ swept, kept, restore: r.body, gone }));
}

// ── 2 and 3. Export on A → download on B; backup on B → restore on A ─────
export async function exportAndBackup(p: Pass): Promise<void> {
  const pid = await projectOf(p, U1);
  const offered = () => p.A.lines().filter((l) => l.msg === 'anypod:offered').map((l) => String(l.sha));
  const n0 = offered().length;
  const exp = await H.rpc(p.A.base, U1, 'projects:export', { id: pid });
  const sent = await H.until(() => offered().length > n0 && offered()[offered().length - 1], 3_000);
  const got = exp.body?.ok ? await H.download(p.B.base, U1, exp.body.downloadToken) : null;
  ok(`[${p.name}] 2: export on A, download on B: the bytes' sha256 is the one A offered`, !!got && !!sent && sha(got) === sent, JSON.stringify({ exp: exp.body?.ok, sent, got: got && sha(got) }));
  ok(`[${p.name}] 2: …and the token is spent: a second download on A is refused`, exp.body?.ok === true && (await H.download(p.A.base, U1, exp.body.downloadToken)) === null);

  const backup = await H.rpc(p.B.base, U1, 'backups:download');
  const zip = backup.body?.ok ? await H.download(p.A.base, U1, backup.body.downloadToken) : null;
  const tok = zip ? await H.upload(p.B.base, U1, zip, 'backup.zip') : '';
  const restored = tok ? await H.rpc(p.A.base, U1, 'backups:restore', { fileToken: tok, confirm: 'restore' }) : null;
  ok(`[${p.name}] 3: backup on B, downloaded on A, uploaded on B, restored on A: every project comes back`,
    !!restored && restored.body?.ok === true && restored.body.restored.length === backup.body.count && restored.body.failed.length === 0, JSON.stringify(restored?.body ?? backup.body));
}

// ── 10. A download aborted mid-stream: the pod survives, the row and bytes go ─
export async function abortedDownload(p: Pass): Promise<void> {
  const pid = await projectOf(p, U1);
  const rows = Array.from({ length: 120_000 }, (_, i) => `${i},${randomBytes(24).toString('hex')}`);
  const csvTok = await H.upload(p.A.base, U1, Buffer.from('n,blob\n' + rows.join('\n')), 'big.csv');
  const parsed = await H.rpc(p.A.base, U1, 'dataset:pickAndParse', { fileToken: csvTok });
  const saved = parsed.body?.ok ? await saveStaged(p.A, U1, pid, 'Big', parsed.body.preview.stagedId) : null;
  const dsId = saved?.body?.dataset?.id as string | undefined;
  const drill = dsId ? await H.rpc(p.A.base, U1, 'visual:rowsDownload', { projectId: pid, datasetId: dsId, encoding: { category: 'n', values: [{ column: 'blob', aggregation: 'count' }] }, filters: [], name: 'Big' }) : null;
  const dl = drill?.body?.downloadToken as string | undefined;
  if (!dl) return ok(`[${p.name}] 10: a big download to abort`, false, JSON.stringify([parsed.body?.ok, saved?.body?.ok, drill?.body]));
  const key = (await rowOf(p, dl))?.storage_key ?? '';
  const ac = new AbortController();
  const res = await fetch(`${p.B.base}/api/files/${dl}`, { headers: U1, signal: ac.signal });
  const reader = res.body!.getReader();
  const first = await reader.read();
  ac.abort();
  await reader.cancel().catch(() => undefined);
  const gone = await H.until(async () => !(await rowOf(p, dl)) && !(await bytesExist(p, 'acme', key)), 8_000);
  const health = await fetch(`${p.B.base}/healthz`).then((r) => r.status, () => 0);
  ok(`[${p.name}] 10: a download aborted after its first chunk: pod B lives, logs nothing uncaught, and the row and bytes are gone`,
    !first.done && health === 200 && p.B.alive() && !/uncaught|ctx\(\) outside/i.test(p.B.err()) && gone, JSON.stringify({ health, gone, size: Number(res.headers.get('content-length')) }));
}

// ── The org wall ─────────────────────────────────────────────────────────
export async function orgWall(p: Pass): Promise<void> {
  const own = await H.upload(p.A.base, U1, GEO, 'acme.geojson');
  const key = (await rowOf(p, own))?.storage_key ?? '';
  const planted = randomBytes(32).toString('base64url');
  await p.db.pool.query(
    `INSERT INTO file_tokens (token_hash, org_id, user_email, kind, storage_key, name, size, expires_at) VALUES ($1, 'globex', 'g1@globex.test', 'upload', $2, 'x.geojson', $3, now() + interval '1 hour')`,
    [hashOf(planted), key, GEO.length]);
  const gpid = await projectOf(p, G1);
  const theirs = await importGeo(p.B, G1, gpid, planted);
  const mine = await importGeo(p.A, U1, await projectOf(p, U1), own);
  ok(`[${p.name}] org wall: a globex row naming acme's bytes resolves only inside globex's staging — refused; acme's own token still works`,
    theirs.ok === false && mine.ok === true, JSON.stringify([theirs, mine]));
}

// ── 1. Upload on A → parse on B → save on A = a one-pod import ───────────
const STAGE_GONE = 'This import is no longer available — bring the file in again.';

/** A CSV that bites: leading zeros, −0, 1e21, a float sum, empties, NBSP, a tab, a BOM inside a cell, duplicate and quoted headers. */
function nastyCsv(rows: number, width: number): Buffer {
  const extra = Math.max(0, width - 6);
  const head = ['"Name ""X"""', 'n', 'n', 'code', 'blank', 'ws', ...Array.from({ length: extra }, (_, i) => `x${i}`)];
  const line = (i: number): string => [
    `"row ${i}"`,
    ['-0', '1e21', String(0.1 + 0.2), String(i)][i % 4],
    String(i * 1.5),
    `"00${i % 10}"`,
    ['"  "', '', '"﻿bom"'][i % 3],
    `" a\tb${i % 7}"`,
    ...Array.from({ length: extra }, (_, c) => `v${i}-${c}`),
  ].join(',');
  return Buffer.from([head.join(','), ...Array.from({ length: rows }, (_, i) => line(i))].join('\n'));
}

/** Every row of a saved dataset, through dataset:page (wire-encoded: −0 and the rest survive). */
async function rowsOf(pod: H.Pod, projectId: string, datasetId: string): Promise<unknown[][]> {
  const out: unknown[][] = [];
  for (let offset = 0; ; offset += 5_000) {
    const page = (await H.rpc(pod.base, U1, 'dataset:page', { projectId, datasetId, offset, limit: 5_000 })).body as { rows?: unknown[][] };
    if (!page.rows?.length) return out;
    out.push(...page.rows);
  }
}
const sameRows = (a: unknown[][], b: unknown[][]): boolean => a.length === b.length && a.every((r, i) => r.length === b[i].length && r.every((v, c) => Object.is(v, b[i][c])));

/** Upload on `up`, parse on `parse`, save on `save`: the preview, and the saved dataset's columns and rows. */
async function importVia(p: Pass, up: H.Pod, parse: H.Pod, save: H.Pod, csv: Buffer, name: string) {
  const pid = await projectOf(p, U1);
  const tok = await H.upload(up.base, U1, csv, name + '.csv');
  const parsed = await H.rpc(parse.base, U1, 'dataset:pickAndParse', { fileToken: tok });
  const stagedId = parsed.body?.preview?.stagedId as string;
  const preview = await H.rpc(parse.base, U1, 'dataset:composePreview', { projectId: pid, base: { inline: { name, stagedId } }, joins: [], offset: 0, limit: 50 });
  const saved = await saveStaged(save, U1, pid, name, stagedId);
  const ds = saved.body?.dataset as { id: string; columns: unknown } | undefined;
  return { preview: (preview.body?.rows ?? []) as unknown[][], saved: saved.body, columns: ds?.columns, rows: ds ? await rowsOf(save, pid, ds.id) : [] };
}

export async function crossPodImport(p: Pass): Promise<void> {
  for (const [label, rows, width] of [['small (this pod also keeps it in memory)', 400, 6], ['30,000 × 10 (past the memory cap: Parquet only)', 30_000, 10]] as const) {
    const csv = nastyCsv(rows, width);
    const one = await importVia(p, p.A, p.A, p.A, csv, `one-${rows}`);
    const cross = await importVia(p, p.A, p.B, p.A, csv, `cross-${rows}`);
    ok(`[${p.name}] 1: ${label} — upload on A, parse on B, save on A gives the one-pod import: columns, types and every cell (Object.is)`,
      cross.rows.length === rows && JSON.stringify(cross.columns) === JSON.stringify(one.columns) && sameRows(cross.rows, one.rows),
      JSON.stringify({ n: [one.rows.length, cross.rows.length], saved: cross.saved?.ok }).slice(0, 300));
    ok(`[${p.name}] 1: ${label} — the composer's preview on B (a limited read of the stage) equals the one-pod preview`,
      cross.preview.length === Math.min(50, rows) && sameRows(cross.preview, one.preview));
  }
}

// ── 11. The row is the truth: saved on B, the stage is gone on A ─────────
export async function rowIsTruth(p: Pass): Promise<void> {
  const pid = await projectOf(p, U1);
  const tok = await H.upload(p.A.base, U1, nastyCsv(20, 6), 'truth.csv');
  const stagedId = (await H.rpc(p.A.base, U1, 'dataset:pickAndParse', { fileToken: tok })).body?.preview?.stagedId as string;
  const onB = await saveStaged(p.B, U1, pid, 'truth', stagedId);
  const againOnA = await saveStaged(p.A, U1, pid, 'truth again', stagedId);
  ok(`[${p.name}] 11: parsed on A (kept in A's memory), saved on B, saved again on A: GONE — the row is the truth`,
    onB.body?.ok === true && againOnA.body?.ok === false && againOnA.body.error === STAGE_GONE, JSON.stringify([onB.body?.ok, againOnA.body]));
  const tok2 = await H.upload(p.A.base, U1, nastyCsv(20, 6), 'mine.csv');
  const mine = (await H.rpc(p.B.base, U1, 'dataset:pickAndParse', { fileToken: tok2 })).body?.preview?.stagedId as string;
  const other = await H.rpc(p.A.base, U2, 'dataset:composePreview', { projectId: pid, base: { inline: { name: 'x', stagedId: mine } }, joins: [], offset: 0, limit: 5 });
  const foreign = await H.rpc(p.A.base, G1, 'dataset:composePreview', { projectId: await projectOf(p, G1), base: { inline: { name: 'x', stagedId: mine } }, joins: [], offset: 0, limit: 5 });
  ok(`[${p.name}] stage wall: another user's, and another org's, read of a stage is GONE`, other.body?.error === STAGE_GONE && foreign.body?.error === STAGE_GONE, JSON.stringify([other.body, foreign.body]).slice(0, 300));
}

export const CASES: Array<(p: Pass) => Promise<void>> = [crossPodImport, rowIsTruth, takeRace, wrongUser, expired, exportAndBackup, sweepSparesTaken, abortedDownload, orgWall];

// ── 9. NEGATIVE CONTROL: no database, the Map — a take does not cross pods ─
export async function memoryControl(A: H.Pod, B: H.Pod): Promise<void> {
  const who = { 'x-test-user': 'dev@local', 'x-test-org': 'default' };
  const pid = (await H.rpc(A.base, who, 'projects:create', { name: 'Memory' })).body.id as string;
  const tok = await H.upload(A.base, who, GEO, 'm.geojson');
  const onB = await importGeo(B, who, pid, tok);
  const onA = await importGeo(A, who, pid, tok);
  ok('[memory] 9: NEGATIVE CONTROL — without a database an upload on A is unknown on B (control: on A it works)', onB.error === TOKEN_GONE && onA.ok === true, JSON.stringify([onB, onA]));
}
