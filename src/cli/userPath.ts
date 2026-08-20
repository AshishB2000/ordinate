// MAIN PROCESS ONLY. A macOS/Linux GUI app launched from Finder/Dock inherits a
// stripped PATH (/usr/bin:/bin:/usr/sbin:/sbin) missing Homebrew, ~/.local/bin,
// nvm/asdf, etc. — so Local CLI detection (claude, agy) wrongly finds nothing in
// the packaged .app even though `npm start` (full terminal PATH) works. This
// recovers the user's real PATH from their login shell and merges in known user
// bin dirs, mutating process.env.PATH that src/localCli's resolveOnPath reads.
//
// Windows is unaffected (no login-shell PATH problem) — this is a no-op there.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Ask the user's login+interactive shell for its PATH (so rc files that add
// nvm/asdf/brew shellenv are sourced). Delimiters isolate PATH from any banner
// the shell may print. Returns '' on any failure (caller falls back to knownDirs).
// Bounded by a hard timeout so a slow/hanging rc file never stalls startup; the
// knownDirs() fallback covers the common installs if this gives up.
export function loginShellPath(): string {
  const shell = process.env.SHELL || '/bin/zsh';
  const D = '__SC_PATH__';
  try {
    const out = execFileSync(
      shell,
      ['-ilc', `printf %s "${D}"; printf %s "$PATH"; printf %s "${D}"`],
      {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
        // Suppress prompt frameworks that block/await a TTY (powerlevel10k's
        // instant prompt is a common cause of the probe timing out under Finder).
        env: { ...process.env, POWERLEVEL9K_INSTANT_PROMPT: 'off', TERM: 'dumb' },
      }
    );
    const parts = String(out).split(D);
    return parts.length >= 2 ? parts[1].trim() : '';
  } catch (_) {
    return '';
  }
}

// Every nvm-managed node version's bin dir ($NVM_DIR/versions/node/<v>/bin).
// nvm is the most common reason a Finder-launched app can't find a CLI: it's
// added to PATH by an rc file the stripped GUI env never sources. Existing dirs
// only; silent on any fs error.
export function nvmBinDirs(home: string): string[] {
  const root = process.env.NVM_DIR || path.join(home, '.nvm');
  const versions = path.join(root, 'versions', 'node');
  try {
    return fs
      .readdirSync(versions)
      .map((v) => path.join(versions, v, 'bin'))
      .filter((d) => {
        try { return fs.statSync(d).isDirectory(); } catch (_) { return false; }
      });
  } catch (_) {
    return [];
  }
}

// Common user bin dirs guaranteed even if the shell probe fails entirely. This
// is the safety net for a Finder launch whose login-shell probe timed out.
export function knownDirs(): string[] {
  const home = process.env.HOME || '';
  const dirs = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin'];
  if (home) {
    dirs.push(
      path.join(home, '.local', 'bin'),
      path.join(home, 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.yarn', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.deno', 'bin'),
    );
    for (const d of nvmBinDirs(home)) dirs.push(d);
  }
  return dirs;
}

// Augment process.env.PATH in place (dedup, original entries kept first). Safe to
// call unconditionally; only meaningful on darwin/linux. Returns the new PATH.
export function resolveUserPath(): string {
  if (process.platform === 'win32') return process.env.PATH || '';
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (p: string | undefined) => {
    for (const d of String(p || '').split(':')) {
      if (d && !seen.has(d)) { seen.add(d); ordered.push(d); }
    }
  };
  add(process.env.PATH);   // keep what we already have first
  add(loginShellPath());   // the real login-shell PATH (Homebrew, nvm, ~/.local/bin…)
  for (const d of knownDirs()) add(d); // belt-and-suspenders fallbacks
  process.env.PATH = ordered.join(':');
  return process.env.PATH;
}

// Self-check: `node src/userPath.js` (the compiled sibling). Simulates a
// stripped Finder PATH and asserts resolveUserPath recovers real user bin dirs.
if (require.main === module) {
  // Explicit annotation (not a cast): assert.ok is an assertion function, and
  // TS requires the call target itself to carry a declared type (TS2775).
  const assert: typeof import('assert') = require('assert');
  if (process.platform === 'win32') { console.log('win32 — PATH fix is a no-op, OK'); process.exit(0); }
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  const before = process.env.PATH;
  const after = resolveUserPath();
  assert.ok(after.includes('/usr/bin'), 'keeps base dirs');
  assert.ok(after.split(':').length >= before.split(':').length, 'never shrinks PATH');
  const home = process.env.HOME || '';
  const recoveredUserDir =
    after.includes('/opt/homebrew/bin') || after.includes('/usr/local/bin') ||
    (home !== '' && after.includes(path.join(home, '.local', 'bin')));
  assert.ok(recoveredUserDir, 'recovers a real user bin dir (homebrew/.local/bin)');

  // knownDirs is the fallback when the shell probe fails — it must include the
  // common user installs even with an empty PATH/HOME-less env.
  const kd = knownDirs();
  assert.ok(kd.includes('/opt/homebrew/bin') && kd.includes('/usr/local/bin'), 'knownDirs has brew/local');
  if (home) {
    assert.ok(kd.includes(path.join(home, '.local', 'bin')), 'knownDirs has ~/.local/bin');
    // If nvm is installed, its node bin dirs must be recovered (the #1 Finder gap).
    const nvm = nvmBinDirs(home);
    for (const d of nvm) assert.ok(kd.includes(d), 'knownDirs includes nvm dir ' + d);
    console.log('knownDirs:', kd.length, 'dirs;', nvm.length, 'nvm node bin dir(s)');
  }
  console.log('PATH FIX OK — recovered', after.split(':').length, 'dirs (was', before.split(':').length + ')');
}
