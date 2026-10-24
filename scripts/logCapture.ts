// What src/app/logger.ts logged, for a suite that asserts on log lines (a
// warning raised once, a secret never written). Each line is the formatted
// message, plus an Error's message when one was logged.

const loggerMod: typeof import('../src/app/logger') = require('../src/app/logger');

export interface Captured {
  /** Every line, in order, `level: message`. */
  readonly lines: string[];
  /** Only the lines of `level`, message only. */
  at(level: 'debug' | 'info' | 'warn' | 'error'): string[];
  /** Puts the previous sink back. */
  restore(): void;
}

export function captureLogs(): Captured {
  const lines: string[] = [];
  const rec = (level: string) => (obj: object, msg: string): void => {
    const err = (obj as { err?: { message?: string } }).err;
    lines.push(`${level}: ${msg}${err?.message && !msg.includes(err.message) ? ' ' + err.message : ''}`);
  };
  const sink: import('../src/app/logger').LogSink = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error'), child: () => sink };
  const prev = loggerMod.useLogger(sink);
  return {
    lines,
    at: (level) => lines.filter((l) => l.startsWith(level + ': ')).map((l) => l.slice(level.length + 2)),
    restore: () => { loggerMod.useLogger(prev); },
  };
}
