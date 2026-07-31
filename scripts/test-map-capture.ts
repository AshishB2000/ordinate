// Self-check for the map-export capture guards. The renderer/main code isn't node-
// runnable (DOM / Electron), so these mirror the two pure guards — keep in sync with
// reportExport.js tilesComplete() and src/ipc/capture.js's box validation.

export {}; // module scope — sibling test scripts share top-level names

// "Every tile loaded" — gates the snapshot so a half-loaded/blank map never exports.
function tilesComplete(total: number, loaded: number): boolean { return total > 0 && loaded >= total; }

// Main-process capture box validation: round + reject non-positive sizes.
// ponytail: rect mirrors an untrusted IPC payload — any matches the real guard's input
function captureBox(rect: any) {
  const r = rect || {};
  const box = {
    x: Math.max(0, Math.round(r.x) || 0),
    y: Math.max(0, Math.round(r.y) || 0),
    width: Math.round(r.width) || 0,
    height: Math.round(r.height) || 0,
  };
  return (box.width <= 0 || box.height <= 0) ? null : box;
}

let failures = 0;
function ok(label: string, cond: boolean) { if (cond) console.log('ok   ' + label); else { console.error('FAIL ' + label); failures++; } }

// tilesComplete: capture only when all tiles are in.
ok('no tiles yet → not complete', !tilesComplete(0, 0));
ok('some tiles still loading → not complete', !tilesComplete(12, 7));
ok('all tiles loaded → complete', tilesComplete(12, 12));
ok('more loaded than counted (race) → complete', tilesComplete(12, 13));

// captureBox: rounds, clamps origin, rejects empty.
ok('valid rect → rounded box', JSON.stringify(captureBox({ x: 10.4, y: 20.6, width: 900.2, height: 540.8 })) === JSON.stringify({ x: 10, y: 21, width: 900, height: 541 }));
ok('zero width → rejected', captureBox({ x: 0, y: 0, width: 0, height: 540 }) === null);
ok('negative size → rejected', captureBox({ x: 0, y: 0, width: -5, height: 540 }) === null);
ok('negative origin clamped to 0', captureBox({ x: -8, y: -3, width: 100, height: 100 })!.x === 0);
ok('missing rect → rejected', captureBox(null) === null);

if (failures) { console.error('\n' + failures + ' assertion(s) failed'); process.exit(1); }
console.log('\nAll map-capture guard checks passed.');
