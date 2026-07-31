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
  const helperSrc = path.join(__dirname, '..', 'native', 'disclaim-exec.c');
  const helperOut = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources', 'disclaim-exec');
  execFileSync('clang', ['-arch', 'x86_64', '-arch', 'arm64', '-O2', '-o', helperOut, helperSrc], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', '--options', 'runtime', '--timestamp=none', helperOut], { stdio: 'inherit' });
  console.log('[afterPack] compiled + ad-hoc signed universal disclaim-exec helper into Resources.');
}

// electron-builder requires the module's exported value to BE the hook function,
// so use `export =` (CommonJS emit: module.exports = afterPack).
export = afterPack;
