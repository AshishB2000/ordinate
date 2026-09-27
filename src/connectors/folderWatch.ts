// Folder watch — MAIN PROCESS ONLY. Electron-free, so the self-check drives it.
//
// A `csv-folder` or `parquet-folder` connection whose "Watch this folder" box
// is ticked (`values.watch === true`) gets ONE fs.watch on its folder. A burst
// of events on files with the connector's extension is coalesced into a single
// callback DEBOUNCE_MS after the last one — a CSV being written arrives as
// several events, and refreshing on the first would read half a file. The
// callback is the caller's (src/ipc/saas.ts): it refreshes every dataset
// imported from that connection through the jobs system, exactly as ↻ does.
//
// Lifecycle: `start()` is called once by the GUI with every stored connection
// and never in a headless (`--cli` / `--mcp`) run, which therefore watches
// nothing. After that `sync()` is called on every write to a connection record,
// so a watcher appears when the box is ticked and closes when it is cleared or
// the connection is deleted. `stopAll()` runs on quit. Watchers are
// non-persistent: they never keep the process alive on their own.

import * as fs from 'fs';
import * as path from 'path';

/** Quiet time after the last event before the folder counts as changed. */
export const DEBOUNCE_MS = 2000;

/** The connectors a folder can be watched for, and the files that count. */
export const WATCHABLE: Readonly<Record<string, string>> = { 'csv-folder': '.csv', 'parquet-folder': '.parquet' };

export type WatchFn = (
  dir: string,
  opts: { recursive: boolean },
  onEvent: (event: string, file: string | null) => void,
) => { close(): void };

const nodeWatch: WatchFn = (dir, opts, onEvent) => {
  const w = fs.watch(dir, { recursive: opts.recursive, persistent: false }, (event, file) =>
    onEvent(String(event), file == null ? null : String(file)));
  // A folder deleted under the watcher: go quiet. The next sync re-creates it.
  w.on('error', () => { /* nothing to refresh from */ });
  return w;
};

export interface Watcher {
  close(): void;
}

/** Watch one folder: `onChange` fires once per burst of events on `ext` files. */
export function watchFolder(
  dir: string,
  ext: string,
  onChange: () => void,
  opts: { recursive?: boolean; debounceMs?: number; watch?: WatchFn } = {},
): Watcher {
  const wait = opts.debounceMs ?? DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const handle = (opts.watch || nodeWatch)(dir, { recursive: opts.recursive === true }, (_event, file) => {
    if (closed) return;
    // No filename (some platforms omit it): cannot filter, so it counts — a
    // spare refresh is cheaper than a missed one.
    if (file !== null && !file.toLowerCase().endsWith(ext)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!closed) onChange();
    }, wait);
  });
  return {
    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      handle.close();
    },
  };
}

/** The fields of a connection record this module reads. */
export interface WatchableConnection {
  id: string;
  projectId: string;
  connectorId: string;
  values: Record<string, unknown>;
}

/** What a connection should be watching, or null. Pure. */
export function watchTarget(c: WatchableConnection): { dir: string; ext: string; recursive: boolean } | null {
  const ext = WATCHABLE[c.connectorId];
  const dir = typeof c.values.path === 'string' ? c.values.path.trim() : '';
  if (!ext || c.values.watch !== true || !dir || !path.isAbsolute(dir)) return null;
  return { dir, ext, recursive: c.values.recursive === true };
}

type Refresh = (projectId: string, connId: string) => void;

const active = new Map<string, { key: string; watcher: Watcher }>(); // connId → its one watcher
let started = false;
let refresh: Refresh = () => { /* set by start() */ };
let watchImpl: WatchFn | undefined;
let debounceMs: number | undefined;

/**
 * Bring one connection's watcher in line with its record (`conn` null = the
 * record was deleted). A no-op before start() — which is how a headless run
 * stays watcher-free even though its connection writes still call this.
 */
export function sync(connId: string, conn: WatchableConnection | null): void {
  if (!started) return;
  const target = conn ? watchTarget(conn) : null;
  const key = target && conn ? [conn.projectId, target.dir, target.ext, target.recursive].join('\0') : '';
  const current = active.get(connId);
  if (current && current.key === key) return; // unchanged — a status write, not a settings change
  if (current) {
    current.watcher.close();
    active.delete(connId);
  }
  if (!target || !conn) return;
  const projectId = conn.projectId;
  try {
    const watcher = watchFolder(target.dir, target.ext, () => refresh(projectId, connId), {
      recursive: target.recursive,
      watch: watchImpl,
      debounceMs,
    });
    active.set(connId, { key, watcher });
  } catch {
    // The folder is gone or unreadable. No watcher; the next write to the
    // connection (or the next launch) tries again.
  }
}

/** Start watching every eligible connection. Headless: nothing, returns 0. */
export function start(opts: {
  headless?: boolean;
  connections: WatchableConnection[];
  refresh: Refresh;
  watch?: WatchFn;
  debounceMs?: number;
}): number {
  if (opts.headless) return 0;
  started = true;
  refresh = opts.refresh;
  watchImpl = opts.watch;
  debounceMs = opts.debounceMs;
  for (const c of opts.connections) sync(c.id, c);
  return active.size;
}

/** Close every watcher (app quit, or a test's teardown). */
export function stopAll(): void {
  for (const e of active.values()) e.watcher.close();
  active.clear();
  started = false;
}

/** How many folders are being watched. */
export function activeCount(): number {
  return active.size;
}

/** Whether this connection has a live watcher. */
export function isWatching(connId: string): boolean {
  return active.has(connId);
}
