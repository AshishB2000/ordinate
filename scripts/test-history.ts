// Self-check for src/history.ts — thread persistence, the id traversal guard,
// and the atomic (temp→rename) write. Stubs the 'electron' module (via
// Module._load) to point userData at a fresh temp dir, then exercises the REAL
// history module against real disk. No framework — ok() counter, process.exit(1).

export {}; // module scope — sibling test scripts share top-level names

const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const Module: any = require('module');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'screenchart-history-'));

const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') {
    return { app: { getPath: (_name: string) => tmpUserData } };
  }
  return origLoad.apply(this, [request, ...rest]);
};

// ponytail: compiled sibling of ../src/history.ts.
const history: typeof import('../src/history') = require('../src/history');

let failures = 0;
function ok(label: string, cond: boolean): void {
  if (cond) console.log('ok   ' + label);
  else { console.error('FAIL ' + label); failures++; }
}

async function main(): Promise<void> {
  await history.init();

  // ── Round-trip save/load ────────────────────────────────────────────────────
  await history.saveThread({ id: '1700000000000', title: 'First', createdAt: 'a', updatedAt: 'b', cropPath: null, messages: [{ role: 'user' }] });
  const loaded = await history.loadThread('1700000000000');
  ok('save+load round-trips a thread', loaded && loaded.title === 'First');
  ok('load preserves messages', loaded && Array.isArray(loaded.messages) && loaded.messages.length === 1);

  // Overwrite (atomic re-save) must not leave a stray .tmp behind.
  await history.saveThread({ id: '1700000000000', title: 'Renamed', updatedAt: 'c' });
  const reloaded = await history.loadThread('1700000000000');
  ok('atomic overwrite updates the thread', reloaded && reloaded.title === 'Renamed');
  const dirFiles = fs.readdirSync(path.join(tmpUserData, 'history', '1700000000000'));
  ok('atomic write leaves no .tmp file behind', !dirFiles.some((f) => f.endsWith('.tmp')));

  // ── Traversal guard: a malformed id must never escape the history dir ─────────
  // Plant a sentinel file OUTSIDE the history dir; a "../"-style id must not reach it.
  const sentinel = path.join(tmpUserData, 'SECRET.txt');
  fs.writeFileSync(sentinel, 'keep me', 'utf8');

  const evilRead = await history.loadThread('../SECRET' as any);
  ok('loadThread rejects a traversal id (returns null)', evilRead === null);

  const evilDelete = await history.deleteThread('../SECRET.txt' as any);
  ok('deleteThread rejects a traversal id (returns false)', evilDelete === false);
  ok('sentinel outside history dir untouched', fs.existsSync(sentinel));

  const slashId = await history.deleteThread('a/b' as any);
  ok('deleteThread rejects an id with a separator', slashId === false);

  // ── Valid delete still works ─────────────────────────────────────────────────
  const okDelete = await history.deleteThread('1700000000000');
  ok('deleteThread removes a valid thread', okDelete === true && (await history.loadThread('1700000000000')) === null);
}

main()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => {
    Module._load = origLoad;
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch (_) { /* noop */ }
    if (failures) { console.error('\n' + failures + ' history check(s) FAILED'); process.exit(1); }
    console.log('\nAll history checks passed.');
  });
