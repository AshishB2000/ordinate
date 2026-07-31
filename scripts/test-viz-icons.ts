// Self-check: every chip type in VIZ_LABELS has a glyph in VIZ_ICONS, and each glyph is a
// well-formed <svg>. The source isn't node-runnable (browser globals), so parse its text.
// (VIZ_LABELS/VIZ_ICONS live in renderResult.js since the hub.js renderer extraction.)

import * as fs from 'fs';
import * as path from 'path';

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'hub', 'renderResult.js'), 'utf8');

// Pull the body of a top-level `const NAME = { ... };` object literal.
function objectBody(name: string): string {
  const start = src.indexOf('const ' + name + ' = {');
  if (start === -1) throw new Error('could not find ' + name);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i); }
  }
  throw new Error('unbalanced braces in ' + name);
}

// Keys at the top level of an object body (ignores nested braces, e.g. SVG strings).
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0, inStr = false, quote = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) { if (c === quote && body[i - 1] !== '\\') inStr = false; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; quote = c; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (depth === 0) {
      // a key is an identifier followed by ':' at depth 0
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(body.slice(i));
      if (m && (i === 0 || /[\s,{]/.test(body[i - 1]))) { keys.push(m[1]); i += m[1].length; }
    }
  }
  return keys;
}

const labelKeys = topLevelKeys(objectBody('VIZ_LABELS'));
const iconKeys = new Set(topLevelKeys(objectBody('VIZ_ICONS')));

let failures = 0;
const missing = labelKeys.filter(k => !iconKeys.has(k));
if (missing.length) { console.error('FAIL missing VIZ_ICONS for: ' + missing.join(', ')); failures++; }
else console.log('ok   every VIZ_LABELS type has an icon (' + labelKeys.length + ' types)');

// Each icon must contain a balanced <svg ...> ... </svg>.
const iconCount = (src.match(/_vi\(/g) || []).length;
const svgPattern = /<svg[\s\S]*?<\/svg>/;
const wrapper = /_vi\('([\s\S]*?)'\)/g;
let m: RegExpExecArray | null, checked = 0, bad = 0;
while ((m = wrapper.exec(src)) !== null) {
  checked++;
  // _vi wraps the inner in <svg>…</svg>; inner should not itself contain a stray </svg>
  if (m[1].includes('<svg') || m[1].includes('</svg>')) bad++;
}
if (checked === 0) { console.error('FAIL no _vi() icon definitions found'); failures++; }
else if (bad) { console.error('FAIL ' + bad + ' icon(s) contain a nested/stray <svg>'); failures++; }
else console.log('ok   ' + checked + ' icon glyphs parse as inner SVG bodies');

// sanity: the assembled svg wrapper is well-formed
if (!svgPattern.test(src) || !src.includes("'<svg")) { console.error('FAIL _vi wrapper malformed'); failures++; }
else console.log('ok   _vi wrapper emits a <svg>…</svg>');

if (failures) { console.error('\n' + failures + ' assertion(s) failed'); process.exit(1); }
console.log('\nAll viz-icon checks passed.');
