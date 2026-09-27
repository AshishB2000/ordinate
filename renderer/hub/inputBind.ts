'use strict';

// Binds src/data/inputTable/edits.js — an input table's edit model: batches,
// their inverses, the undo stack, paste parsing and fill down — as the global
// `OrdInputEdits`, then clears the shim's globals (see cjsShim.ts). The SAME
// module main replays saved batches with, so the grid and the stored table
// cannot disagree about what an edit does.
//
// Classic global-scope renderer <script>: no import/export.

const OrdInputEdits: OrdInputEditsApi = (window as any).module.exports;
(window as any).module = undefined;
(window as any).exports = undefined;
