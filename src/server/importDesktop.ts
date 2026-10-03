// `npm run import-desktop -- <path-to-userData> [--org <id>]` (T5.1): load a
// desktop install's projects into one org of this server.
//
// Records (every JSON file src/app/recordFs.ts calls a record: project.json,
// datasets/<id>.json, visuals, dashboards, versions, trash, comments, capture
// history, themes, user templates, …) are written through recordFs exactly as
// the stores write them — rows when DATABASE_URL is set, the org's files
// otherwise. Everything else under those trees (Parquet, snapshots, images)
// is copied under the org's DATA_DIR path. Each record keeps its id.
//
// Idempotent: a record is an upsert, a file an overwrite, so a second run
// leaves the same state. It never deletes: a record removed from the desktop
// after an import stays in the org. Settings (config.json — it holds
// connection passwords and API keys, T5.3's store), backups, logs and
// leftover `.tmp` files are not imported.
//
// Reads DATA_DIR and DATABASE_URL like the server (./env.ts). A desktop
// project in a sync folder is a symlink in projects/: followed.

import * as fs from 'fs';
import * as path from 'path';
import { env } from './env';
import { enterServerMode, runInContext } from './context';
import { createPool, scrubbed } from './db/pool';
import { migrate } from './db/migrate';
import * as recordFs from '../app/recordFs';
import * as appPaths from '../app/paths';

const TREES = ['projects', 'history', 'templates', 'themes.json'];

export interface ImportSummary {
  projects: number;
  records: number;
  files: number;
  bytes: number;
}

/** Every regular file under `dir` (following links), as '/'-separated paths relative to `root`. */
function walk(root: string, rel: string, out: string[]): void {
  const abs = path.join(root, rel);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs); // follows a sync-folder symlink
  } catch {
    return;
  }
  if (st.isFile()) {
    const base = path.basename(rel);
    if (!base.endsWith('.tmp') && base !== '.DS_Store') out.push(rel.split(path.sep).join('/'));
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of fs.readdirSync(abs).sort()) walk(root, path.join(rel, name), out);
}

/** Import `source` (a desktop userData folder) into the CURRENT request's org. */
export async function importInto(source: string): Promise<ImportSummary> {
  const files: string[] = [];
  for (const t of TREES) walk(source, t, files);
  const dest = appPaths.userData();
  const sum: ImportSummary = { projects: 0, records: 0, files: 0, bytes: 0 };
  for (const rel of files) {
    const from = path.join(source, ...rel.split('/'));
    const to = path.join(dest, ...rel.split('/'));
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    if (recordFs.isRecordPath(rel)) {
      await recordFs.writeFile(to, await fs.promises.readFile(from));
      sum.records++;
      if (/^projects\/[^/]+\/project\.json$/.test(rel)) sum.projects++;
    } else {
      await fs.promises.copyFile(from, to);
      sum.files++;
      sum.bytes += fs.statSync(to).size;
    }
  }
  return sum;
}

async function main(argv: string[]): Promise<void> {
  const args = [...argv];
  let org = 'default';
  const at = args.indexOf('--org');
  if (at >= 0) {
    org = args[at + 1] || '';
    args.splice(at, 2);
  }
  const source = args[0] ? path.resolve(args[0]) : '';
  if (!source || args.length !== 1) throw new Error('usage: npm run import-desktop -- <path-to-userData> [--org <id>]');
  if (!fs.existsSync(path.join(source, 'projects'))) throw new Error(`${source} has no projects/ folder — point at the desktop app's userData`);
  const cfg = env();
  enterServerMode(cfg.dataDir);
  const pool = cfg.databaseUrl ? createPool(cfg.databaseUrl, () => undefined) : null;
  try {
    if (pool && cfg.databaseUrl) {
      try {
        await migrate(pool);
      } catch (err) {
        throw scrubbed(err, cfg.databaseUrl);
      }
      recordFs.useRecordDb(pool);
    }
    const who = { user: { email: 'import-desktop', role: 'admin' as const }, org: { id: org } };
    const s = await runInContext(who, 'import-desktop', () => importInto(source));
    process.stdout.write(
      `imported into org ${org} (${pool ? 'Postgres' : 'files'}): ${s.projects} projects, ${s.records} records, ` +
        `${s.files} files (${(s.bytes / 1048576).toFixed(1)} MB)\n`,
    );
  } finally {
    recordFs.useRecordDb(null);
    if (pool) await pool.end();
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`ordinate: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
