// The DuckDB sidecar CHILD. Owns the connection; speaks newline-delimited JSON
// on stdin/stdout. Never touches the filesystem beyond
// the database file.
//
// WHY A PROCESS RATHER THAN THE WORKER THREAD IN src/duckdbWorker.ts
//
// The worker exists to give the main thread a SYNCHRONOUS query(): it parks the
// caller in `Atomics.wait` on a SharedArrayBuffer while the worker runs the
// query and writes bytes back into shared memory. That machinery is ~534 lines
// and the most delicate code in the repo — a growable SAB, a four-slot control
// block, spurious-wakeup loops, an overflow protocol, and a shutdown path that
// must never `terminate()` mid-native-call or the whole process aborts.
//
// A child process gets the same synchronicity for free, because the PARENT can
// block on a pipe read (see src/duckdbSidecar.ts). Measured on this machine, a
// round trip through the pipe costs 0.076 ms for an 83 KB payload and 0.009 ms
// for a scalar — against the ~0.5 ms the SAB handshake pays per call. The most
// common call in the app (a metric card: one scalar) gets FASTER.
//
// It also buys something the worker cannot offer at all: a wedged engine becomes
// killable. A hung worker thread can only be orphaned.
//
// PROTOCOL. One JSON object per line, both directions. Requests:
//     {"id":1,"kind":"query"|"exec","sql":"…","params":[…]}
//     {"id":2,"kind":"close"}
// Replies:
//     {"id":1,"ok":true,"text":"{\"columns\":[…],\"rows\":[…]}","micros":123}
//     {"id":1,"ok":false,"code":"query","message":"…","micros":123}
//     {"type":"ready"} | {"type":"init-error","message":"…"}
//
// `text` is the SAME columnar-JSON payload `encodeText` produces for the worker,
// carried as a string so `decodeRows` in src/duckdb.ts parses it unchanged. One
// wire format, one decoder, two transports.
//
// There is deliberately NO result-size ceiling here: the parent applies it, and
// applying it in both places would mean two limits to keep in step.

import type { DuckDBConnection } from '@duckdb/node-api';
import { encodeText, openConnection, type Scalar } from './duckdbEngine';

interface Request {
  id: number;
  kind: 'query' | 'exec' | 'close';
  sql?: string;
  params?: Scalar[];
}

let connection: DuckDBConnection | null = null;

function write(obj: unknown): void {
  // writeSync, not process.stdout.write: a reply must be on the wire before the
  // next request is read, and stdout to a pipe is asynchronous in Node. A parent
  // blocked on a synchronous read would otherwise wait for a flush that only
  // happens when this process next yields.
  const line = JSON.stringify(obj) + '\n';
  const buf = Buffer.from(line, 'utf8');
  let off = 0;
  while (off < buf.length) {
    try {
      off += require('fs').writeSync(1, buf, off, buf.length - off);
    } catch (err: any) {
      if (err && (err.code === 'EAGAIN' || err.code === 'EINTR')) continue;
      throw err;
    }
  }
}

function elapsedMicros(t0: bigint): number {
  return Number((process.hrtime.bigint() - t0) / 1000n);
}

async function handle(req: Request): Promise<void> {
  const t0 = process.hrtime.bigint();
  try {
    if (req.kind === 'close') {
      connection = null;
      write({ id: req.id, ok: true, text: '', micros: 0 });
      process.exit(0);
    }
    if (!connection) throw new Error('DuckDB connection is not open');
    const sql = String(req.sql ?? '');

    if (req.kind === 'exec') {
      // Bound parameters are a query-path concept; exec is app-generated DDL/DML.
      await connection.run(sql);
      write({ id: req.id, ok: true, text: '', micros: elapsedMicros(t0) });
      return;
    }

    // Values are BOUND here — never concatenated into the SQL text.
    const params = Array.isArray(req.params) ? req.params : [];
    const reader = params.length
      ? await connection.runAndReadAll(sql, params as never)
      : await connection.runAndReadAll(sql);
    write({ id: req.id, ok: true, text: encodeText(reader), micros: elapsedMicros(t0) });
  } catch (err: unknown) {
    write({
      id: req.id,
      ok: false,
      code: 'query',
      message: err instanceof Error ? err.message : String(err),
      micros: elapsedMicros(t0),
    });
  }
}

// Serialize calls. DuckDB's connection is not re-entrant, and the parent's
// synchronous path assumes replies arrive in request order. The chain starts at
// `ready`, so nothing is handled before the connection exists. A rejected
// handler must not poison the queue — every exit path above already replies, so
// the catch here only keeps the chain alive.
const ready = (async () => {
  const dbPath = process.argv[2] || ':memory:';
  connection = await openConnection(dbPath);
  write({ type: 'ready' });
})().catch((err: unknown) => {
  write({ type: 'init-error', message: err instanceof Error ? err.message : String(err) });
});

let queue: Promise<void> = ready;
let carry = '';

process.stdin.on('data', (chunk: Buffer) => {
  carry += chunk.toString('utf8');
  for (;;) {
    const i = carry.indexOf('\n');
    if (i < 0) break;
    const line = carry.slice(0, i);
    carry = carry.slice(i + 1);
    if (!line) continue;
    let req: Request;
    try {
      req = JSON.parse(line) as Request;
    } catch {
      continue; // an unparseable line is dropped; the parent's timeout covers it
    }
    queue = queue.then(() => handle(req)).catch(() => undefined);
  }
});

// The parent closing stdin is the ordinary way this process ends.
process.stdin.on('end', () => process.exit(0));
