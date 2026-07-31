// Local CLI detection — MAIN PROCESS ONLY.
//
// Detection means two things and nothing more:
//   1. Resolve a registry binaryName on the user's PATH (cross-platform).
//   2. Run ONLY `<resolvedBinary> <versionArgs>` to read its --version.
//
// SECURITY: the only commands ever executed are a registry binary with its
// fixed versionArgs. No user/AI/config string is ever turned into a command,
// and we never spawn a shell (execFile, args array, shell:false implicitly).

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import type { ChildProcess, ExecFileOptions } from 'child_process';
import { knownDirs } from './userPath';
import { wrapCommand } from './disclaim';

const VERSION_TIMEOUT_MS = 3000;

// A registry entry. Entries with installOnly/retired have no probe-able binary
// and are never executed.
interface RegistryEntry {
  id: string;
  displayName: string;
  vendor: string;
  binaryName?: string;
  versionArgs?: string[];
  versionRegex?: RegExp;
  installUrl: string;
  installOnly?: boolean;
  retired?: boolean;
  retiredNote?: string;
  note?: string;
}

// One detection result (internal shape; resolvedPath is stripped by toPublic).
interface DetectResult {
  id: string;
  status: 'not_found' | 'installed' | 'retired';
  version: string | null;
  resolvedPath: string | null;
}

// Live --version probes, so a hung probe or app quit can kill the whole process
// GROUP. We spawn detached (own group leader), so process.kill(-pid) reaps the
// probe AND any background daemon it forked — the classic "CLI spawns a daemon
// that inherits the pipe" case below. Detaching also makes macOS attribute the
// child's file access to the CLI, not to Screenchart, so detection never trips a
// Photos / Documents / Downloads / Music TCC prompt under our app's name.
const liveProbes = new Set<ChildProcess>();

// ponytail: POSIX group-kill; Windows lacks process.kill(-pid) → leader-only fallback.
function killTree(child: ChildProcess | null | undefined, signal: NodeJS.Signals) {
  if (!child || child.pid == null) return;
  try { process.kill(-child.pid, signal); }
  catch (_) { try { child.kill(signal); } catch (_) {} }
}

// Kill every still-running probe. Called from main.js on app will-quit.
export function killAllProbes(): void {
  for (const child of liveProbes) killTree(child, 'SIGKILL');
  liveProbes.clear();
}

// Claude Code accepted --model values. The `claude` CLI has NO models-list
// command (`claude models`/`claude config` just print the banner), but it DOES
// accept a --model flag. This is therefore a CURATED STATIC list, not a live
// fetch — update it when the CLI's accepted aliases/IDs change. Aliases first,
// then versioned IDs.
export const CLAUDE_MODELS: string[] = [
  'sonnet', 'opus', 'haiku',
  'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5',
];

// Codex has NO models-list command (the subcommands are exec/review/login/mcp/…;
// `codex models` is treated as a prompt). The CLI fetches a list from the server
// and caches it, but never prints it — so, like CLAUDE_MODELS, this is a CURATED
// STATIC list of names the `codex -m` flag accepts. Update when OpenAI's lineup
// changes. (gpt-5.5 is the CLI's current default; `-c model="o3"` is in --help.)
export const CODEX_MODELS: string[] = [
  'gpt-5.5', 'gpt-5-codex', 'gpt-5', 'o3', 'o4-mini',
];

// Default version matcher: first semver-ish token in the output.
const SEMVER = /(\d+\.\d+\.\d+[\w.-]*)/;

// Known CLI registry. Extend by adding entries. Entries with installOnly:true
// have no known stable binary to probe, so they only ever appear under
// "Available to install" and are never executed.
export const REGISTRY: RegistryEntry[] = [
  {
    id: 'claude',
    displayName: 'Claude Code',
    vendor: 'Anthropic official CLI',
    binaryName: 'claude',
    versionArgs: ['--version'],
    versionRegex: SEMVER,
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview',
  },
  {
    id: 'antigravity',
    displayName: 'Antigravity (Google)',
    vendor: 'Google official CLI',
    binaryName: 'agy',
    versionArgs: ['--version'],
    versionRegex: SEMVER,
    installUrl: 'https://antigravity.google',
  },
  {
    // RETIRED: Google stopped serving Gemini CLI requests for individual /
    // Pro / Ultra users on 2026-06-18. Kept (not deleted) so the UI can show an
    // honest retired state; never probed, never executed. The BYOK Gemini
    // provider (paid API key) is a separate path and is unaffected.
    id: 'gemini',
    displayName: 'Gemini CLI',
    vendor: 'Google official CLI',
    binaryName: 'gemini',
    retired: true,
    retiredNote: 'Gemini CLI retired by Google (June 2026) — use Antigravity (Google).',
    installUrl: 'https://antigravity.google',
  },
  {
    id: 'codex',
    displayName: 'Codex CLI',
    vendor: 'OpenAI official CLI',
    binaryName: 'codex',
    versionArgs: ['--version'],
    versionRegex: SEMVER,
    installUrl: 'https://github.com/openai/codex',
  },
  {
    id: 'grok',
    displayName: 'Grok CLI',
    vendor: 'xAI (community CLI)',
    binaryName: 'grok',
    versionArgs: ['--version'],
    versionRegex: SEMVER,
    installUrl: 'https://github.com/superagent-ai/grok-cli',
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    vendor: 'opencode.ai (BYOK)',
    binaryName: 'opencode',
    versionArgs: ['--version'],
    versionRegex: SEMVER,
    installUrl: 'https://opencode.ai',
  },
  {
    // id is 'cursor' (not 'cursor-agent') so the cursor.png agent logo
    // auto-resolves; the binary on PATH is 'cursor-agent'.
    id: 'cursor',
    displayName: 'Cursor Agent',
    vendor: 'Cursor (Anysphere)',
    binaryName: 'cursor-agent',
    versionArgs: ['--version'],
    versionRegex: SEMVER,
    installUrl: 'https://cursor.com/cli',
    // Honest heads-up: cursor-agent is a full agent runtime (sandbox supervisor,
    // file indexer, background service), so on first run macOS may prompt for
    // cross-app access. The other CLIs are plain API clients and don't. We pass
    // only minimal read-only flags — the analysis is a pure API round-trip on the
    // image and works whether or not that permission is granted.
    note: 'On first run, macOS may show a “Cursor wants to access data from other apps” prompt. It’s safe to choose Don’t Allow — Screenchart only needs Cursor to analyze your image, which still works.',
  },
];

// Renderer-safe registry view (no detection, no paths) — for the UI to know the
// full set of known CLIs even before/without a scan.
export function publicRegistry() {
  return REGISTRY.map(e => ({
    id: e.id,
    displayName: e.displayName,
    vendor: e.vendor,
    binaryName: e.binaryName || null,
    installUrl: e.installUrl,
    installOnly: Boolean(e.installOnly),
    retired: Boolean(e.retired),
    retiredNote: e.retiredNote || null,
    note: e.note || null,
  }));
}

// The directories detection searches: PATH first, then common user-install bin
// dirs (~/.local/bin, ~/bin, /opt/homebrew/bin, /usr/local/bin via knownDirs) that
// a GUI/stripped PATH often omits — notably ~/.local/bin, where the Antigravity
// installer puts `agy`. Deduped, PATH entries kept first. This makes detection
// robust even when process.env.PATH never got the login-shell augmentation.
function searchDirs(): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  const add = (d: string) => { if (d && !seen.has(d)) { seen.add(d); dirs.push(d); } };
  for (const d of (process.env.PATH || '').split(path.delimiter)) add(d);
  for (const d of knownDirs()) add(d); // fallbacks beyond PATH
  return dirs;
}

// Resolve a bare binary name without spawning anything. Mirrors which/where
// semantics over searchDirs() (PATH + known user bin dirs): apply PATHEXT on
// Windows, check existence + (POSIX) executable bit. Returns the absolute path
// or null. Logs where it looked and what it resolved (per CLI) for diagnosis.
export function resolveOnPath(binaryName: string | null | undefined): string | null {
  if (!binaryName) return null;
  // A name containing a separator is not a bare PATH lookup — reject it so we
  // never resolve attacker-influenced relative/absolute paths.
  if (/[\\/]/.test(binaryName)) return null;

  const dirs = searchDirs();
  const isWin = process.platform === 'win32';
  const exts = isWin
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map(s => s.trim()).filter(Boolean)
    : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, binaryName + ext);
      try {
        fs.accessSync(full, isWin ? fs.constants.F_OK : fs.constants.X_OK);
        console.log(`[localCli] resolve "${binaryName}" -> ${full}`);
        return full;
      } catch (_) { /* keep looking */ }
    }
  }
  console.log(`[localCli] resolve "${binaryName}" -> not found in ${dirs.length} dirs`);
  return null;
}

// Run `<resolvedPath> <versionArgs>` to read a version string. Always resolves
// (never throws/hangs): { version: string|null }. version is null when the
// command fails/times out/produces nothing parseable, but the binary still
// exists, so callers mark "installed, version unknown".
export function readVersion(resolvedPath: string, versionArgs: string[] | undefined, regex: RegExp | undefined): Promise<{ version: string | null }> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (version: string | null) => { if (!settled) { settled = true; resolve({ version }); } };

    let child!: ChildProcess;
    try {
      // TCC: run the probe via disclaim-exec (packaged macOS) so the CLI is its
      // own responsible process — macOS won't attribute its file access to
      // Screenchart. No-op passthrough in dev / non-mac.
      // cwd = os.tmpdir(): a non-protected scoped dir so the probe never runs from
      // the app bundle, "/", or a user folder. detached: true → own process group
      // (see killTree / liveProbes above).
      const { cmd, args } = wrapCommand(resolvedPath, Array.isArray(versionArgs) ? versionArgs : []);
      child = execFile(
        cmd,
        args,
        // `as ExecFileOptions`: node's typings omit `detached`, but execFile
        // forwards its options to spawn, so it works at runtime.
        { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20, killSignal: 'SIGKILL', cwd: os.tmpdir(), detached: true } as ExecFileOptions,
        (_err, stdout, stderr) => {
          liveProbes.delete(child);
          const out = `${stdout || ''}${stderr || ''}`;
          const m = (regex || SEMVER).exec(out);
          finish(m ? m[1] : null);
        }
      );
    } catch (_) {
      return finish(null); // spawn failed (e.g. EACCES) — treat as version-unknown
    }
    liveProbes.add(child);

    // Hard guard against a hung probe: some CLIs spawn a background daemon that
    // inherits the stdout pipe, so execFile's callback NEVER fires even after the
    // child is killed — which would hang detectAll and freeze the "Scanning your
    // PATH…" spinner forever. Resolve regardless after a bounded wait, killing the
    // whole GROUP (killTree) so that daemon dies too. The binary was still found,
    // so detectOne marks it installed (version unknown). unref() so the timer can't
    // keep the app alive.
    const guard = setTimeout(() => {
      liveProbes.delete(child);
      killTree(child, 'SIGKILL');
      finish(null);
    }, VERSION_TIMEOUT_MS + 1500);
    if (guard.unref) guard.unref();
  });
}

// Detect one registry entry by id. install-only entries are never probed.
export async function detectOne(id: string): Promise<DetectResult | null> {
  const entry = REGISTRY.find(e => e.id === id);
  if (!entry) return null;

  const base: DetectResult = { id: entry.id, status: 'not_found', version: null, resolvedPath: null };
  // Retired CLIs are never probed or executed — surface them as 'retired'.
  if (entry.retired) return { ...base, status: 'retired' };
  if (entry.installOnly || !entry.binaryName) return base;

  const resolvedPath = resolveOnPath(entry.binaryName);
  if (!resolvedPath) return base;

  const { version } = await readVersion(resolvedPath, entry.versionArgs, entry.versionRegex);
  return { id: entry.id, status: 'installed', version, resolvedPath };
}

// Detect every registry entry. Safe on a machine with none installed.
export async function detectAll(): Promise<Array<DetectResult | null>> {
  console.log('[localCli] detect: searching dirs:', searchDirs().join(path.delimiter));
  return Promise.all(REGISTRY.map(e => detectOne(e.id)));
}

// Merge detection results with the registry into a renderer-safe list.
// Strips resolvedPath (internal only); fills not_found for un-probed/missing ids.
export function toPublic(results: Array<DetectResult | null | undefined> | null | undefined) {
  const byId: Record<string, DetectResult> = {};
  for (const r of (results || [])) if (r && r.id) byId[r.id] = r;
  return REGISTRY.map(e => {
    const r: Partial<DetectResult> = byId[e.id] || {};
    const status = r.status === 'installed' ? 'installed'
      : e.retired ? 'retired'
      : 'not_found';
    return {
      id: e.id,
      displayName: e.displayName,
      vendor: e.vendor,
      binaryName: e.binaryName || null,
      installUrl: e.installUrl,
      installOnly: Boolean(e.installOnly),
      retired: Boolean(e.retired),
      retiredNote: e.retiredNote || null,
      status,
      version: r.version || null,
    };
  });
}

// Self-check: `node src/localCli.js`. Proves readVersion never hangs — even on a
// process that produces no version and won't exit on its own — and still reads a
// real version. This is the guard that keeps "Scanning your PATH…" from spinning
// forever in the packaged Finder app.
if (require.main === module) {
  // Explicit annotation (not a cast): assert.ok is an assertion function, and
  // TS requires the call target itself to carry a declared type (TS2775).
  const assert: typeof import('assert') = require('assert');
  (async () => {
    if (process.platform === 'win32') { console.log('win32 — readVersion guard check skipped'); return; }
    const t0 = Date.now();
    // `sleep 30` exits with no output and outlives VERSION_TIMEOUT_MS — the old
    // code would hang here; the guard must resolve it (version null) in bounded time.
    const hung = await readVersion('/bin/sleep', ['30'], /(\d+\.\d+\.\d+)/);
    const elapsed = Date.now() - t0;
    assert.strictEqual(hung.version, null, 'hanging probe resolves with null version');
    assert.ok(elapsed < VERSION_TIMEOUT_MS + 4000, 'hanging probe resolves in bounded time, not forever (' + elapsed + 'ms)');

    // A normal binary still yields a version (node prints vX.Y.Z).
    const real = await readVersion(process.execPath, ['--version'], /v?(\d+\.\d+\.\d+)/);
    assert.ok(real.version && /\d+\.\d+\.\d+/.test(real.version), 'reads a real version: ' + real.version);

    // Group-kill: killTree must reap the WHOLE detached process group, not just the
    // leader — else a CLI's forked daemon orphans on timeout/quit. Spawn a detached
    // parent that backgrounds a grandchild (sleep 30), print the grandchild's pid,
    // killTree the leader, then assert the grandchild is gone.
    const { spawn }: typeof import('child_process') = require('child_process');
    const gpid = await new Promise<number>((res) => {
      const p = spawn('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], { detached: true });
      let buf = '';
      p.stdout!.on('data', (d) => { buf += d; });
      setTimeout(() => { killTree(p, 'SIGKILL'); setTimeout(() => res(parseInt(buf.trim(), 10)), 300); }, 300);
    });
    let orphanAlive = true;
    try { process.kill(gpid, 0); } catch (_) { orphanAlive = false; }
    assert.ok(gpid && !orphanAlive, 'group-kill reaped the grandchild (no orphan), pid=' + gpid);

    console.log('readVersion guard OK — hung probe null in', elapsed + 'ms; node', real.version + '; group-kill reaped orphan pid', gpid);
  })().catch((e) => { console.error('FAIL', e && e.message); process.exit(1); });
}
