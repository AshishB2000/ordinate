'use strict';

// Regenerate assets/provider-icons.json from the INSTALLED simple-icons.
//
// Why this exists: src/icons.ts needs exactly 28 provider and connector icons,
// each represented by three small strings (path, hex, title). Depending on `simple-icons` at runtime to get
// them shipped 25 MB into the app bundle — 15 MB of icons/*.svg and two 5 MB
// index files — to deliver about 41 KB of data.
//
// So simple-icons is now a devDependency and this generator bakes all 28 provider-plus-connector entries
// into a committed JSON asset, exactly like scripts/build-vendor.js does for the
// vgplot bundle. Same rule as that script: it EXITS NON-ZERO if an expected icon
// has vanished, so a simple-icons upgrade breaks the build loudly instead of
// silently downgrading a provider or connector to a styled badge at runtime.
//
//   npm run build:icons     # after bumping simple-icons
//
// Not part of any other script — the output is committed.

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'assets', 'provider-icons.json');

// The provider and connector export-name maps live in src/icons.ts and stay the
// single source of truth. Requiring them here is safe and non-circular: icons.ts reads
// THIS file's output, it does not require simple-icons any more, and a missing
// output file is handled by its own try/catch.
let PROVIDER_SI, CONNECTOR_SI;
try {
  ({ PROVIDER_SI, CONNECTOR_SI } = require('../src/icons'));
} catch (err) {
  console.error('Could not load src/icons.js — run `npm run build:ts` first.');
  console.error(String((err && err.message) || err));
  process.exit(1);
}

let si;
try {
  si = require('simple-icons');
} catch (_) {
  console.error('simple-icons is not installed. It is a devDependency:  npm install');
  process.exit(1);
}

// Read package.json off disk rather than through require(): simple-icons has an
// "exports" map that does not expose it, so require() throws ERR_PACKAGE_PATH_NOT_EXPORTED.
// The version is the whole point of the provenance line — do not let it degrade
// to "unknown" silently.
const version = (() => {
  try {
    const p = path.join(__dirname, '..', 'node_modules', 'simple-icons', 'package.json');
    return JSON.parse(fs.readFileSync(p, 'utf8')).version || 'unknown';
  } catch (_) {
    return 'unknown';
  }
})();

const out = {};
const missing = [];
const ALL_SI = { ...PROVIDER_SI, ...CONNECTOR_SI };

for (const [id, name] of Object.entries(ALL_SI)) {
  const ic = si[name];
  if (!ic || !ic.path) {
    missing.push(`${id} → ${name}`);
    continue;
  }
  // Exactly the three fields src/icons.ts reads. `hex` stays raw; the
  // light/dark legibility decision (safeColor) is applied at runtime so the
  // threshold can change without regenerating this file.
  out[id] = { path: ic.path, hex: ic.hex, title: ic.title, export: name };
}

if (missing.length) {
  console.error(`simple-icons ${version} is missing ${missing.length} mapped export(s):`);
  for (const m of missing) console.error('  ' + m);
  console.error('\nEither the export was renamed upstream or the brand was dropped.');
  console.error('Fix PROVIDER_SI or CONNECTOR_SI in src/icons.ts, then re-run. Refusing to write a');
  console.error('partial file — a silent gap here becomes a missing logo at runtime.');
  process.exit(1);
}

const payload = { _generated: 'scripts/build-icons.js', _simpleIconsVersion: version, icons: out };
fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');

const kb = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log(`[build-icons] simple-icons ${version} → ${Object.keys(out).length} icons, ${kb} KB`);
console.log(`[build-icons] wrote ${path.relative(path.join(__dirname, '..'), OUT)}`);
