// Resolve + apply the disclaim-exec helper (see native/disclaim-exec.c).
//
// wrapCommand(bin, args) returns the {cmd, args} to actually spawn/execFile so
// that macOS treats the CLI agent as its OWN TCC responsible process instead of
// blaming Screenchart for the agent's file access (Photos/Desktop/Documents/…).
//
// The compiled helper only exists in a PACKAGED macOS build (scripts/afterPack.js
// builds it into Contents/Resources/disclaim-exec). In dev (`npm start`) or on
// other platforms it's absent, so wrapCommand is a no-op passthrough — the spawn
// behaves exactly as before. MAIN PROCESS ONLY (uses process.resourcesPath).

import * as fs from 'fs';
import * as path from 'path';

let cached: string | null | undefined; // undefined = unresolved, string = path, null = unavailable

export function helperPath(): string | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform === 'darwin' && process.resourcesPath) {
    const p = path.join(process.resourcesPath, 'disclaim-exec');
    try { fs.accessSync(p, fs.constants.X_OK); cached = p; } catch (_) { /* not packaged */ }
  }
  return cached;
}

// Prefix a command with the disclaim helper when available; otherwise return it
// unchanged. Because the helper uses POSIX_SPAWN_SETEXEC (same pid/fds/cwd/env/
// pgid), callers need change NOTHING else — stdin/stdout piping, timeout, and
// process-group kill all still apply to the real agent.
export function wrapCommand(bin: string, args?: string[]): { cmd: string; args: string[] } {
  const h = helperPath();
  return h ? { cmd: h, args: [bin, ...(args || [])] } : { cmd: bin, args: args || [] };
}

// Self-check: `node src/disclaim.js [path-to-compiled-helper]`.
// Always asserts the no-helper passthrough. If a compiled helper path is passed,
// also proves SETEXEC actually execs the target (disclaim-exec /bin/echo hi → hi).
if (require.main === module) {
  // Explicit annotation (not a cast): assert.ok is an assertion function, and
  // TS requires the call target itself to carry a declared type (TS2775).
  const assert: typeof import('assert') = require('assert');

  // 1) No helper (plain node: process.resourcesPath is undefined) → passthrough.
  const w = wrapCommand('claude', ['--version']);
  assert.strictEqual(w.cmd, 'claude', 'passthrough cmd when no helper');
  assert.deepStrictEqual(w.args, ['--version'], 'passthrough args when no helper');
  assert.deepStrictEqual(wrapCommand('x').args, [], 'undefined args → []');

  const helper = process.argv[2];
  if (helper && fs.existsSync(helper)) {
    const { execFileSync }: typeof import('child_process') = require('child_process');
    const out = execFileSync(helper, ['/bin/echo', 'disclaim-ok'], { encoding: 'utf8' }).trim();
    assert.strictEqual(out, 'disclaim-ok', 'helper execs target in place (SETEXEC)');
    console.log('disclaim self-check OK — passthrough + helper exec verified');
  } else {
    console.log('disclaim self-check OK — passthrough verified (pass a compiled helper path to also test exec)');
  }
}
