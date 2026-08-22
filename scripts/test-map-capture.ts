// Self-check for the map-export capture guard. The main-process code is not
// node-runnable (Electron), so captureBox mirrors src/ipc/capture.ts.
//
// NOTE: this is a mirror, not an import — it passes even if the real guard is
// deleted. Extract the real one into an importable module when src/ipc/capture.ts
// is next touched. The former tilesComplete half was removed in the MapLibre port:
// it counted .leaflet-tile DOM nodes and no longer exists in the product.

export {}; // module scope — sibling test scripts share top-level names
import { ok, failureCount } from './selfcheck';


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



// captureBox: rounds, clamps origin, rejects empty.
ok('valid rect → rounded box', JSON.stringify(captureBox({ x: 10.4, y: 20.6, width: 900.2, height: 540.8 })) === JSON.stringify({ x: 10, y: 21, width: 900, height: 541 }));
ok('zero width → rejected', captureBox({ x: 0, y: 0, width: 0, height: 540 }) === null);
ok('negative size → rejected', captureBox({ x: 0, y: 0, width: -5, height: 540 }) === null);
ok('negative origin clamped to 0', captureBox({ x: -8, y: -3, width: 100, height: 100 })!.x === 0);
ok('missing rect → rejected', captureBox(null) === null);

if (failureCount()) { console.error('\n' + failureCount() + ' assertion(s) failed'); process.exit(1); }
console.log('\nAll map-capture guard checks passed.');
