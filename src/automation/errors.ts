// Automation error classes and the exit code each one maps to. Its own file so
// the registry and its handlers can both import it without a require cycle.

export type ErrorCode = 'usage' | 'not_found' | 'runtime' | 'disabled';

/** Process exit code per error class. Documented in docs/automation.md. */
export const EXIT: Readonly<Record<'ok' | ErrorCode, number>> = {
  ok: 0, runtime: 1, usage: 2, not_found: 3, disabled: 4,
};

/** An expected failure with a class. Anything else thrown is a `runtime` error. */
export class AutomationError extends Error {
  code: ErrorCode;
  /** 'args': the arguments failed the registry schema — over MCP, a protocol error (-32602). */
  stage?: 'args';
  constructor(code: ErrorCode, message: string, stage?: 'args') {
    super(message);
    this.name = 'AutomationError';
    this.code = code;
    if (stage) this.stage = stage;
  }
}
