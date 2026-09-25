'use strict';

// Lets the hub load ONE CommonJS module as a classic <script>: the app's
// formatter, src/app/format.js, so the renderer and main format every figure
// with the same code (see that file's header).
//
// A compiled TS module writes `exports.x = …` and nothing else — it has no
// runtime imports, by rule — so a global `exports` object is all it needs.
// formatBind.js, the very next script, takes the result as `OrdFormat` and
// REMOVES both globals again: geoMatch.js and mapThumb.js probe
// `typeof module !== 'undefined'` to decide whether they are in Node, and must
// keep answering "no".
//
// Classic global-scope renderer <script>: no import/export.

(window as any).module = { exports: {} };
(window as any).exports = (window as any).module.exports;
