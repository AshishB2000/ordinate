// electron-builder afterPack hook (macOS only).
//
// Electron ships its own Info.plist with a set of default privacy
// usage-description strings (camera, microphone, bluetooth, audio capture).
// Screenchart uses NONE of those APIs — it needs SCREEN RECORDING only, which
// we declare via build.mac.extendInfo (NSScreenCaptureUsageDescription).
//
// These stray keys don't trigger a prompt on their own, but they show up if a
// user inspects the app and read as "why does a screenshot tool want my camera?"
// So we strip them here to keep the declared privacy surface to exactly one key:
// screen recording. The Delete keys below are also a defensive backstop against a
// future Electron adding Photos/Desktop/Documents/Downloads descriptions.
//
// PlistBuddy (built into macOS) is deterministic; Delete on a missing key throws,
// which we swallow per key so the hook is idempotent.

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { AfterPackContext } from 'app-builder-lib';

// electron-builder's Arch enum, by value. Imported by value rather than by name
// so this hook does not depend on `builder-util`'s export shape.
const ARCH_NAME: Record<number, string> = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

// `predist:mac` force-installs @duckdb/node-bindings-darwin-x64 so a UNIVERSAL
// build has both slices to merge. `files: ["**/*"]` then sweeps BOTH bindings
// into EVERY per-arch pack — and each carries a ~112 MB libduckdb.dylib.
//
// For a universal build that was harmless: @electron/universal collapses the two
// into one fat dylib and the per-arch trees are thrown away. For a PER-ARCH DMG
// it is not harmless at all — the foreign binding would ship, and an arm64 user
// would download 112 MB of x86-64 code that cannot execute on their machine.
//
// So strip the binding that does not match the pack being built. Universal packs
// are left alone: the merger needs both, and it is the thing that makes them one.
function stripForeignDuckdbBinding(appOutDir: string, appName: string, arch: number): void {
  const archName = ARCH_NAME[arch];
  if (!archName || archName === 'universal') return;

  const root = path.join(appOutDir, `${appName}.app`, 'Contents', 'Resources',
                         'app.asar.unpacked', 'node_modules', '@duckdb');
  if (!fs.existsSync(root)) return;

  const keep = `node-bindings-darwin-${archName}`;
  let freed = 0;
  for (const entry of fs.readdirSync(root)) {
    if (!entry.startsWith('node-bindings-darwin-') || entry === keep) continue;
    const victim = path.join(root, entry);
    freed += dirBytes(victim);
    fs.rmSync(victim, { recursive: true, force: true });
    console.log(`[afterPack] ${archName}: removed ${entry} (foreign architecture)`);
  }
  // Loud on a no-op: if the keep-name ever stops matching what the binding is
  // actually called, this silently ships both again — which is the bug it exists
  // to prevent, and it would only show up as a fat download nobody measures.
  if (!fs.existsSync(path.join(root, keep))) {
    throw new Error(
      `[afterPack] expected ${keep} in the ${archName} pack and it is not there. `
      + `Found: ${fs.readdirSync(root).join(', ') || '(nothing)'}. Refusing to ship a `
      + 'pack whose DuckDB binding cannot be identified.',
    );
  }
  if (freed) console.log(`[afterPack] ${archName}: freed ${(freed / 1048576).toFixed(0)} MB`);

  thinFatBinaries(path.join(root, keep), archName);
}

// The binding named `node-bindings-darwin-arm64` ships a UNIVERSAL libduckdb.dylib:
// measured 111.6 MiB total, x86_64 59,743,808 + arm64 57,236,352. So even after the
// foreign PACKAGE is gone, an Apple-silicon DMG still carries ~57 MiB of x86-64 that
// can never execute. `lipo -thin` removes it.
//
// This must run in afterPack, not later: thinning rewrites the Mach-O and invalidates
// any signature, and afterSign re-signs the app after this hook.
//
// Only ever THINS TO THE PACK'S OWN ARCH, and skips a binary that does not contain it
// — so the worst case is a no-op, never a binary stripped of the slice it needs.
function thinFatBinaries(dir: string, archName: string): void {
  const lipoArch = archName === 'x64' ? 'x86_64' : archName;
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { thinFatBinaries(p, archName); continue; }
    if (!/\.(dylib|node|so)$/.test(entry.name)) continue;

    let archs: string;
    try {
      archs = execFileSync('lipo', ['-archs', p], { encoding: 'utf8' }).trim();
    } catch (_) { continue; } // not a Mach-O lipo understands — leave it alone
    const list = archs.split(/\s+/);
    if (list.length < 2 || !list.includes(lipoArch)) continue;

    const before = fs.statSync(p).size;
    execFileSync('lipo', ['-thin', lipoArch, p, '-output', p + '.thin']);
    fs.renameSync(p + '.thin', p);
    const after = fs.statSync(p).size;
    console.log(
      `[afterPack] ${archName}: thinned ${entry.name} (${archs} -> ${lipoArch}), `
      + `${((before - after) / 1048576).toFixed(0)} MB removed`,
    );
  }
}

function dirBytes(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
  }
  return total;
}

const STRIP = [
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSAudioCaptureUsageDescription',
  // Defensive: never ship any of these even if Electron starts adding them.
  'NSPhotoLibraryUsageDescription',
  'NSPhotoLibraryAddUsageDescription',
  'NSDesktopFolderUsageDescription',
  'NSDocumentsFolderUsageDescription',
  'NSDownloadsFolderUsageDescription',
  'NSContactsUsageDescription',
  'NSLocationWhenInUseUsageDescription',
];

async function afterPack(context: AfterPackContext): Promise<void> {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const plist = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Info.plist');

  let removed = 0;
  for (const key of STRIP) {
    try {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plist], { stdio: 'ignore' });
      removed++;
    } catch (_) { /* key absent — fine, hook stays idempotent */ }
  }
  console.log(`[afterPack] ${appName}.app: stripped ${removed} unused usage-description key(s); screen recording is the only one declared.`);

  stripForeignDuckdbBinding(context.appOutDir, appName, context.arch as unknown as number);

  // Compile the disclaim-exec helper (see native/disclaim-exec.c) into the app's
  // Resources so the CLI-agent spawn can shed TCC responsibility. Build it ONCE on
  // the final merged UNIVERSAL app (skip the per-arch *-temp dirs), as a universal
  // Mach-O so it isn't lipo-merged. afterSign re-signs the whole app afterwards,
  // but we ad-hoc sign the helper here too so it's valid immediately.
  if (context.appOutDir.includes('-temp')) return;
  const helperSrc = path.join(__dirname, '..', 'native', 'disclaim-exec.c');
  const helperOut = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'disclaim-exec');
  execFileSync('clang', ['-arch', 'x86_64', '-arch', 'arm64', '-O2', '-o', helperOut, helperSrc], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', helperOut], { stdio: 'inherit' });
  console.log('[afterPack] compiled + ad-hoc signed universal disclaim-exec helper into Resources.');
}

// electron-builder requires the module's exported value to BE the hook function,
// so use `export =` (CommonJS emit: module.exports = afterPack).
export = afterPack;
