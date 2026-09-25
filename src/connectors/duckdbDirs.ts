// WHICH FOLDERS DuckDB MAY READ — MAIN PROCESS ONLY.
//
// Split out of src/connectors/local.ts (.claude/rules/file-size.md). That file's
// job is "three local-file connectors"; this one's is "the persisted
// allow-list, and applying it before the engine is locked". They are separate
// jobs that happen to be used together, and only one of them is about SQL.
//
// The whole subtlety lives in WHEN the lock is applied. DuckDB's
// `allowed_directories` can only be set BEFORE `enable_external_access=false`,
// and that lock is irreversible for the process lifetime — so a folder that was
// not inside the lock when it closed cannot be read until the next launch. Hence
// two entry points, deliberately not one:
//
//   noteDir()        records a folder WITHOUT touching the engine. Browsing a
//                    folder in a connection form must never narrow what a later
//                    folder can reach.
//   prepareEngine()  records it AND hardens with every folder remembered so far.
//                    Called at the LAST responsible moment — the first query.
//
// `registeredDirs` is what lets main.ts pre-register everything at boot, which
// is what makes these connectors work on the second and every later session.

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { hardenConnection } from '../ipc/mosaic';

/** How many picked folders stay in the allow-list registry, newest first. */
const MAX_REGISTERED_DIRS = 32;

function userDataDir(): string | null {
  try {
    const d = app.getPath('userData');
    return typeof d === 'string' && d ? d : null;
  } catch {
    return null; // no Electron (a unit test, or a stripped harness) — skip hardening
  }
}

/**
 * The folders DuckDB has previously been pointed at, newest first.
 *
 * Exported for ONE caller: `main.ts` at startup. `allowed_directories` can only
 * be set BEFORE `enable_external_access=false`, and the lock is irreversible for
 * the process lifetime — so a folder that is not inside the lock when it closes
 * cannot be read until the next launch. Pre-registering the known folders at
 * boot is what makes these connectors work on the second and every later
 * session regardless of whether the user opens a Mosaic chart first.
 *
 * Returns [] when nothing has ever been registered, which is the signal main.ts
 * uses to skip hardening entirely and keep the bridge lazy.
 */
export function registeredDirs(base: string): string[] {
  return readRegistry(base);
}

function registryFile(base: string): string {
  return path.join(base, 'connectors', 'duckdb-dirs.json');
}

function readRegistry(base: string): string[] {
  try {
    const raw = fs.readFileSync(registryFile(base), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is string => typeof d === 'string' && d !== '');
  } catch {
    return []; // missing or corrupt — a registry is a cache, never a fatal
  }
}

/**
 * Record `dir` as a folder DuckDB may be allowed to read, newest first.
 *
 * Entries that no longer exist are dropped on every write, and the list is
 * capped: `allowed_directories` is a security control, and an unbounded list of
 * every folder ever touched would erode it. Best-effort — a failed write costs
 * an extra restart later, never correctness.
 *
 * Written atomically (temp sibling + rename), matching `datasets.writeJsonAtomic`.
 */
function rememberDir(base: string, dir: string): void {
  try {
    const prev = readRegistry(base);
    const next = [dir, ...prev.filter((d) => d !== dir)]
      .filter((d) => {
        try {
          return fs.statSync(d).isDirectory();
        } catch {
          return false;
        }
      })
      .slice(0, MAX_REGISTERED_DIRS);
    // Unchanged: do not rewrite the file on every query.
    if (next.length === prev.length && next.every((d, j) => d === prev[j])) return;
    const file = registryFile(base);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort */
  }
}

/**
 * Record `dir` WITHOUT touching the engine.
 *
 * Used by the folder connectors' `listTables`, which reads the directory with
 * `fs` and needs no DuckDB at all. Keeping it engine-free matters: applying the
 * lock is irreversible, so it must happen at the LAST responsible moment — the
 * first actual query — not when a user is merely filling in a connection form.
 * Browsing a folder therefore never narrows what a later folder can reach.
 */
export function noteDir(dir: string): void {
  const base = userDataDir();
  if (base) rememberDir(base, dir);
}

/**
 * Remember `dir`, then make sure the engine is hardened WITH it (and with every
 * folder remembered from earlier sessions) rather than without it.
 *
 * Called immediately before engine access, never earlier. Idempotent and cheap
 * after the first call: `hardenConnection` memoises, so this is a
 * resolved-promise await plus one small file read.
 *
 * Never throws. If hardening fails or Electron is absent the engine simply stays
 * as it is, which is the un-hardened, fully working state.
 */
export async function prepareEngine(dir: string): Promise<void> {
  const base = userDataDir();
  if (!base) return;
  rememberDir(base, dir);
  await hardenEngine();
}

/**
 * Harden with every folder remembered so far, recording nothing new. For a
 * caller that only ever reads userData (SQL over the project's own datasets)
 * but must not be the one that locks the engine WITHOUT the folders the local
 * connectors were pointed at — whichever caller hardens first fixes the list
 * for the whole process.
 */
export async function hardenEngine(): Promise<void> {
  const base = userDataDir();
  if (!base) return;
  const dirs = [base, ...readRegistry(base)];
  const unique = dirs.filter((d, i) => dirs.indexOf(d) === i);
  await hardenConnection(unique);
}
