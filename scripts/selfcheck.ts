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

/** Exit the process with the suite's verdict. The last line every suite ends on. */
export function finish(): void {
  process.exit(failures ? 1 : 0);
}
