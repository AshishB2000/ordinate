// The ONE self-check scaffold. Every scripts/test-*.ts, smoke-*.ts and
// bench-*.ts used to declare its own `function ok(...)` (nine different
// signatures across 70+ copies) and its own `let failures = 0` — and one copy
// (test-pipelineDuck.ts) had the arguments REVERSED, so an assertion
// copy-pasted across that boundary silently became always-pass. This module is
// the single definition they all import instead.
//
// Output format is the one CI logs already show: `ok   <label>` on success,
// `FAIL <label>` on failure. `extra` (a measurement, a JSON dump) is printed
// only on failure, where it explains the break. Dependency-free on purpose —
// the suites run under bare `node --test` with no framework.

let failures = 0;

export function ok(label: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log('ok   ' + label);
  } else {
    console.error('FAIL ' + label + (extra === undefined ? '' : '  ' + String(extra)));
    failures++;
  }
}

/** How many assertions have failed so far — for suites that branch on it. */
export function failureCount(): number {
  return failures;
}

/**
 * Exit the process with the suite's verdict. The last line every suite ends on.
 * A bare exit around a DuckDB worker — busy, and sometimes even idle — aborts
 * the process (`Napi::Error`, src/engine/duckdbClose.ts), so when the
 * bridge is loaded this closes every DuckDB worker (the bridge's and the
 * per-org pool's) through its own queue and exits once all have gone.
 * The bridge is read from the require cache, so this module loads nothing.
 */
export function finish(): void {
  const code = failures ? 1 : 0;
  process.exitCode = code; // the verdict even if the process ends on its own (a wedged worker let go)
  const duck = require.cache[require.resolve('../src/engine/duckdb')]?.exports as typeof import('../src/engine/duckdb') | undefined;
  if (!duck) process.exit(code);
  void duck.closeAll().then(() => process.exit(code));
  setTimeout(() => process.exit(code), 120_000).unref(); // a wedged worker never says it left
}
