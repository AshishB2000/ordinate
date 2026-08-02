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

import * as path from 'path';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import type { AfterPackContext } from 'app-builder-lib';

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

  // Compile the disclaim-exec helper (see native/disclaim-exec.c) into the app's
  // Resources so the CLI-agent spawn can shed TCC responsibility. Build it ONCE on
  // the final merged UNIVERSAL app (skip the per-arch *-temp dirs), as a universal
  // Mach-O so it isn't lipo-merged. afterSign re-signs the whole app afterwards,
  // but we ad-hoc sign the helper here too so it's valid immediately.
  if (context.appOutDir.includes('-temp')) return;

  // A universal build MUST carry both DuckDB bindings, or the app silently loses
  // its entire compute engine on Intel.
  //
  // `libduckdb.dylib` is already a fat Mach-O upstream, so it is fine either way;
  // the arch-specific file is the small `duckdb.node`, which is why
  // build.mac.x64ArchFiles names only that. The x64 one arrives ONLY via
  // `predist:mac`'s `npm i --force --no-save @duckdb/node-bindings-darwin-x64`
  // — npm skips it otherwise because the package declares `cpu: x64` and this is
  // an arm64 machine. `--no-save` means it is in neither package.json nor the
  // lockfile, so ANY later `npm ci`/`npm install` removes it again.
  //
  // That is exactly how dist/mac-universal shipped with arm64 bindings only.
  // Nothing failed; DuckDB would just have been absent on Intel, and every
  // resident query would have fallen back to its pure-JS path — slow, not loud.
  // So assert it here: a broken Intel build must fail the build, not the user.
  const isUniversal = context.appOutDir.includes('universal');
  if (isUniversal) {
    const unpacked = path.join(
      context.appOutDir, `${appName}.app`, 'Contents', 'Resources',
      'app.asar.unpacked', 'node_modules', '@duckdb',
    );
    const missing = (['arm64', 'x64'] as const).filter(
      (a) => !fs.existsSync(path.join(unpacked, `node-bindings-darwin-${a}`, 'duckdb.node')),
    );
    if (missing.length) {
      throw new Error(
        `[afterPack] universal build is missing DuckDB binding(s): ${missing.join(', ')}.\n` +
        `  Run 'npm run predist:mac' (it force-installs @duckdb/node-bindings-darwin-x64,\n` +
        `  which npm skips on arm64 and which any 'npm ci' removes), then rebuild.\n` +
        `  Shipping without the x64 binding leaves Intel Macs with no DuckDB engine.`,
      );
    }
    console.log('[afterPack] verified both DuckDB bindings (arm64 + x64) are present.');
  }

  const helperSrc = path.join(__dirname, '..', 'native', 'disclaim-exec.c');
  const helperOut = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'disclaim-exec');
  execFileSync('clang', ['-arch', 'x86_64', '-arch', 'arm64', '-O2', '-o', helperOut, helperSrc], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', helperOut], { stdio: 'inherit' });
  console.log('[afterPack] compiled + ad-hoc signed universal disclaim-exec helper into Resources.');
}

// electron-builder requires the module's exported value to BE the hook function,
// so use `export =` (CommonJS emit: module.exports = afterPack).
export = afterPack;
