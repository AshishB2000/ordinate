'use strict';

// The emit guard itself: does `findStale` actually notice a stale .js?
//
// WHY THIS EXISTS. scripts/check-emit.ts is the thing that catches a `tsc`
// that exits 0 without writing output. A guard that silently stops detecting
// is worse than no guard — it is the same green-check-that-proves-nothing the
// bug it watches for produces. So the four cases are pinned against a real
// temp tree with real mtimes, not mocks.
//
//   npm run build:ts && node scripts/test-checkEmit.js

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findStale } from './check-emit';
import { ok, failureCount, finish } from './selfcheck';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-emit-'));
const src = path.join(tmp, 'src');
fs.mkdirSync(src, { recursive: true });

/**
 * Write `<name>.ts` and `<name>.js` with the .js mtime `skewMs` off the .ts.
 * BOTH mtimes are set explicitly from one base: `statSync().mtime` truncates to
 * whole milliseconds while the filesystem keeps nanoseconds, so reading the .ts
 * time back and reusing it would land a "same time" .js fractionally in the past
 * and make the equal case look stale.
 */
function pair(name: string, skewMs: number | null): void {
  const base = new Date(Date.now() - 60_000);
  const ts = path.join(src, name + '.ts');
  fs.writeFileSync(ts, 'export const x = 1;\n');
  fs.utimesSync(ts, base, base);
  if (skewMs === null) return; // no sibling .js at all
  const js = path.join(src, name + '.js');
  fs.writeFileSync(js, 'exports.x = 1;\n');
  const shifted = new Date(base.getTime() + skewMs);
  fs.utimesSync(js, shifted, shifted);
}

pair('fresh', 5000); // .js newer than .ts  → fine
pair('equal', 0); // same mtime            → fine ("not older than")
pair('stale', -5000); // .js older than .ts   → FAIL
pair('gone', null); // no .js                → FAIL

// A declaration file emits nothing, so it must never be reported.
fs.writeFileSync(path.join(src, 'types.d.ts'), 'export type T = 1;\n');

const bad = findStale(tmp, ['src']);
const names = bad.map((b) => b.ts).sort();

ok('stale .js is caught', names.includes(path.join('src', 'stale.ts')), names);
ok('missing .js is caught', names.includes(path.join('src', 'gone.ts')), names);
ok('newer .js passes', !names.includes(path.join('src', 'fresh.ts')), names);
ok('equal mtime passes', !names.includes(path.join('src', 'equal.ts')), names);
ok('.d.ts is ignored', !names.some((n) => n.endsWith('.d.ts')), names);
ok('exactly two findings', bad.length === 2, names);

const reasons = Object.fromEntries(bad.map((b) => [path.basename(b.ts), b.reason]));
ok('reason for a stale .js', reasons['stale.ts'] === 'stale', reasons);
ok('reason for a missing .js', reasons['gone.ts'] === 'missing', reasons);

// The real tree must be clean — this is the same assertion `build:ts` makes,
// and it is what fails if someone adds a source outside the include globs.
const repo = path.resolve(__dirname, '..');
const live = findStale(repo);
ok('repo has no stale emit', live.length === 0, live.map((b) => `${b.reason} ${b.ts}`).join(', '));

fs.rmSync(tmp, { recursive: true, force: true });
if (failureCount() === 0) console.log('check-emit: all good');
finish();
