// The one logger for code outside Fastify's own request log — MAIN PROCESS and
// worker threads alike. Server: pino (`app.log`, installed by src/server/app.ts
// buildApp, with its REDACT_PATHS), and inside a request every line carries its
// `reqId` and `org`. Elsewhere (a test, a worker thread, before the app is
// built): pino-shaped JSON lines on stderr. No `console.*` in src/ (lint).
//
// Console-compatible on purpose — `logger.warn('[x] failed:', err.message)`:
// the arguments are formatted like console's into `msg`; an Error among them
// also goes in `err` (stack and all, through pino's serializer). The `org` is a
// tenant id, never a label in /metrics.

import { format } from 'util';

// Who is asking, when there is a request: src/server/context.ts installs this
// reader when it loads. A leaf, so a worker thread's import graph never reaches
// the request context (scripts/test-computeWorker.ts).
let contextOf: () => { requestId: string; org: { id: string } } | undefined = () => undefined;

/** src/server/context.ts, once: how this module finds the current request. */
export function readContextWith(fn: typeof contextOf): void {
  contextOf = fn;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

/** What pino (and Fastify's logger) is, as far as this module needs. */
export interface LogSink {
  debug(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  child(bindings: Record<string, unknown>): LogSink;
}

const LEVELS: Record<Level, number> = { debug: 20, info: 30, warn: 40, error: 50 };

function stderrSink(bindings: Record<string, unknown> = {}): LogSink {
  const line = (level: Level) => (obj: object, msg: string): void => {
    if (level === 'debug') return;
    const o = obj as { err?: unknown };
    const err = o.err instanceof Error ? { type: o.err.name, message: o.err.message, stack: o.err.stack } : o.err;
    process.stderr.write(JSON.stringify({ level: LEVELS[level], time: Date.now(), ...bindings, ...obj, ...(err ? { err } : {}), msg }) + '\n');
  };
  return { debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error'), child: (b) => stderrSink({ ...bindings, ...b }) };
}

let base: LogSink = stderrSink();

/** Server boot (app.ts) or a test: where lines go from now on. Null is the stderr default. Returns the previous sink. */
export function useLogger(sink: LogSink | null): LogSink {
  const prev = base;
  base = sink ?? stderrSink();
  return prev;
}

function sinkNow(): LogSink {
  const c = contextOf();
  return c ? base.child({ reqId: c.requestId, org: c.org.id }) : base;
}

function emit(level: Level, args: unknown[]): void {
  const err = args.find((a): a is Error => a instanceof Error);
  const msg = format(...args.map((a) => (a instanceof Error ? a.message : a)));
  sinkNow()[level](err ? { err } : {}, msg);
}

/** An info line whose fields are the payload, for a log drain to index — not formatted into `msg`. */
export function logFields(msg: string, fields: Record<string, unknown>): void {
  sinkNow().info(fields, msg);
}

export const logger = {
  debug: (...args: unknown[]): void => emit('debug', args),
  info: (...args: unknown[]): void => emit('info', args),
  warn: (...args: unknown[]): void => emit('warn', args),
  error: (...args: unknown[]): void => emit('error', args),
};
