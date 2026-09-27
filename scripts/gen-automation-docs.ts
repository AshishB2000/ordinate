// Write docs/automation.md from the automation command registry.
//
//   npm run build:ts && node scripts/gen-automation-docs.js
//
// scripts/test-automation.ts regenerates the same text and fails when the
// committed file differs — run this after changing src/automation/registry.ts.

export {}; // module scope — sibling scripts share top-level names

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const Module: any = require('module'); // ponytail: Node's loader hook is untyped

// The registry pulls in main-process modules that import 'electron' (never
// called at load) — a stub is all this needs.
const origLoad = Module._load;
Module._load = function (request: string, ...rest: any[]): any {
  if (request === 'electron') return { app: { getPath: () => '', getAppPath: () => '' }, ipcMain: { handle: () => {} } };
  return origLoad.apply(this, [request, ...rest]);
};

const { COMMANDS }: typeof import('../src/automation/registry') = require('../src/automation/registry');
const { generateDocs }: typeof import('../src/automation/docs') = require('../src/automation/docs');

const out = path.join(__dirname, '..', 'docs', 'automation.md');
fs.writeFileSync(out, generateDocs(COMMANDS) + '\n', 'utf8');
console.log('wrote', path.relative(process.cwd(), out));
