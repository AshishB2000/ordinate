/**
 * Emit guard: every `.ts` in the build must have a sibling `.js` that is not
 * older than it.
 *
 * WHY THIS EXISTS. `tsc --incremental` trusts its `.tsbuildinfo` and never
 * stats the output files. If the buildinfo says a source is already emitted,
 * tsc exits 0 and writes nothing — whether or not the `.js` is actually there.
 * That is a silent failure: `prestart`, `pretest`, `predist:*` and `smoke` all
 * go through `build:ts`, so the app, the suites and a packaged installer can
 * every one of them run stale renderer code while CI (cold cache) stays green.
 *
 * It has happened twice. Phase 5 logged it as blocker B1
 * (docs/phase-5/04-csp-and-testing.md) when a worktree's `node_modules` was a
 * symlink to the main checkout's and both wrote the same buildinfo; the
 * recorded paths are relative to the buildinfo's own directory, so each
 * checkout read the other's signatures as its own. Moving `tsBuildInfoFile`
 * out of `node_modules` (see the three tsconfigs) removes that particular
 * collision. This guard is the check that catches the next one, whatever
 * causes it — a deleted `.js`, an interrupted build, a cache from a different
 * branch.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Directories whose every `.ts` emits a sibling `.js` in place — the `include`
 * globs of tsconfig.main.json (`src`, `preload`, `scripts`) and
 * tsconfig.renderer.json (`renderer`). Keep in sync with those two files.
 */
const ROOTS = ['src', 'preload', 'scripts', 'renderer'];

/**
 * `renderer/hub/svelte` is EXCLUDED from tsconfig.renderer.json: esbuild
 * bundles those modules, nothing is emitted beside them.
 */
const SKIP = new Set(['node_modules', '.git', path.join('renderer', 'hub', 'svelte')]);

/** The per-checkout incremental cache the tsconfigs point at. */
const BUILDINFO_DIR = '.tsbuildinfo';

const CONFIGS = ['tsconfig.main.json', 'tsconfig.renderer.json'];

export interface StaleEmit {
  ts: string;
  reason: 'missing' | 'stale';
}

function walk(cwd: string, dir: string, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // a root that does not exist here is not a failure
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name) && !SKIP.has(path.relative(cwd, p))) walk(cwd, p, out);
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      out.push(p);
    }
  }
}

/** Every `.ts` under `roots` whose sibling `.js` is missing or older than it. */
export function findStale(cwd: string, roots: string[] = ROOTS): StaleEmit[] {
  const sources: string[] = [];
  for (const r of roots) walk(cwd, path.join(cwd, r), sources);

  const bad: StaleEmit[] = [];
  for (const ts of sources) {
    const js = ts.slice(0, -3) + '.js';
    let jsStat: fs.Stats;
    try {
      jsStat = fs.statSync(js);
    } catch {
      bad.push({ ts: path.relative(cwd, ts), reason: 'missing' });
      continue;
    }
    if (jsStat.mtimeMs < fs.statSync(ts).mtimeMs) {
      bad.push({ ts: path.relative(cwd, ts), reason: 'stale' });
    }
  }
  return bad;
}

function report(bad: StaleEmit[]): void {
  for (const b of bad) {
    console.error(`  ${b.reason === 'missing' ? 'no .js  ' : 'stale .js'}  ${b.ts}`);
  }
}

function rebuild(cwd: string): void {
  fs.rmSync(path.join(cwd, BUILDINFO_DIR), { recursive: true, force: true });
  // TypeScript 7 does not export `bin/tsc`, but it does export package.json,
  // so resolve the bin through that rather than guessing the path.
  const tsPkg = require.resolve('typescript/package.json');
  const { bin } = require(tsPkg) as { bin: { tsc: string } };
  const tsc = path.join(path.dirname(tsPkg), bin.tsc);
  for (const cfg of CONFIGS) {
    // Shell-free: args array, never `shell: true`.
    execFileSync(process.execPath, [tsc, '-p', cfg], { cwd, stdio: 'inherit' });
  }
}

function main(): void {
  const cwd = path.join(__dirname, '..');
  let bad = findStale(cwd);
  if (bad.length === 0) return;

  // Self-heal ONCE. A stale cache is the common cause and clearing it is cheap,
  // so `build:ts` fixes itself rather than stopping the user; only a second
  // failure — which the cache cannot explain — is fatal.
  let healed = false;
  if (process.argv.includes('--heal')) {
    console.error(
      `check-emit: ${bad.length} source(s) with no current .js — clearing ${BUILDINFO_DIR}/ and rebuilding once.`,
    );
    report(bad);
    rebuild(cwd);
    healed = true;
    bad = findStale(cwd);
    if (bad.length === 0) return;
  }

  console.error('\ncheck-emit: tsc exited 0 but these sources have no current .js:');
  report(bad);
  console.error(
    healed
      ? '\nA clean rebuild did not fix it, so the incremental cache is not the cause.\n' +
          'Most likely a source outside the include globs of tsconfig.main.json /\n' +
          'tsconfig.renderer.json, or an emit that failed silently.\n'
      : `\nRun \`npm run build\` — it clears ${BUILDINFO_DIR}/ and rebuilds once on its own.\n` +
          `By hand: rm -rf ${BUILDINFO_DIR} && npm run build\n`,
  );
  process.exit(1);
}

if (require.main === module) main();
