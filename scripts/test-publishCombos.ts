// Publish to folder — which filter-bar states a published dashboard carries
// (src/publish/combos.ts): enumeration, the cap and its two modes, trimming
// and what it reports, and the dialog's summary line.
//
//   npm run build:ts && node scripts/test-publishCombos.js

export {}; // module scope — sibling test scripts share top-level names
import { ok, finish } from './selfcheck';
import * as c from '../src/publish/combos';

const dom = (label: string, n: number, def = 0): c.ControlDomain => ({
  id: label, label, options: ['All', ...Array.from({ length: n }, (_, i) => `${label}${i + 1}`)], defaultIndex: def,
});

// ── Keys ─────────────────────────────────────────────────────────────────────
ok('comboKey: option indexes joined by dots', c.comboKey([0, 2, 1]) === '0.2.1');
ok('parseKey inverts comboKey', JSON.stringify(c.parseKey('0.2.1')) === '[0,2,1]');
ok('no controls: one state, the empty key', JSON.stringify(c.enumerateAll([])) === '[""]' && c.parseKey('').length === 0);

// ── Full product ─────────────────────────────────────────────────────────────
const two = [dom('region', 3), dom('sku', 2)];
const all = c.enumerateAll(two);
ok('all: every combination (4 × 3 = 12)', all.length === 12);
ok('all: first control varies slowest, in a stable order', all[0] === '0.0' && all[1] === '0.1' && all[3] === '1.0' && all[11] === '3.2');
ok('all: no duplicates', new Set(all).size === all.length);
const p1 = c.planCombos(two, 256);
ok('plan: fits the cap → mode all, 12 keys', p1.mode === 'all' && p1.keys.length === 12 && p1.fullCount === 12 && p1.dropped.length === 0);

// ── Single mode ──────────────────────────────────────────────────────────────
const big = [dom('a', 20, 3), dom('b', 20), dom('c', 20)];
const p2 = c.planCombos(big, 256);
ok('plan: 21³ = 9,261 does not fit 256 → mode single', p2.mode === 'single' && p2.fullCount === 9261);
ok('single: the default state comes first', p2.keys[0] === '3.0.0');
ok('single: default + each control\'s other options = 1 + 3×20 = 61', p2.keys.length === 61);
ok('single: every key differs from the default in at most ONE control',
  p2.keys.every((k) => c.parseKey(k).filter((v, i) => v !== [3, 0, 0][i]).length <= 1));
ok('single: nothing trimmed when it fits', p2.dropped.length === 0);

// ── Trimming ─────────────────────────────────────────────────────────────────
const p3 = c.planCombos([dom('a', 50, 7), dom('b', 50)], 40);
ok('trim: the state count fits the cap', p3.keys.length <= 40, p3.keys.length);
ok('trim: "All" and the default option are never trimmed',
  p3.domains[0].options[0] === 'All' && p3.domains[0].options[p3.domains[0].defaultIndex] === 'a7');
ok('trim: every trimmed option is reported under its control',
  p3.dropped.reduce((n, d) => n + d.options.length, 0) === (51 + 51) - p3.domains.reduce((n, d) => n + d.options.length, 0));
ok('trim: the default index follows its option after trimming', p3.domains[0].options[p3.domains[0].defaultIndex] === 'a7');
const huge = c.planCombos([dom('x', 500)], 1000);
ok('trim: a control past MAX_OPTIONS_PER_CONTROL keeps its first options',
  huge.domains[0].options.length === c.MAX_OPTIONS_PER_CONTROL && huge.dropped[0].options.length === 501 - c.MAX_OPTIONS_PER_CONTROL);
ok('trim: …and reports what it dropped even in mode all', huge.mode === 'all' && huge.dropped[0].control === 'x');
const tiny = c.planCombos([dom('a', 5, 2), dom('b', 5)], 1);
ok('cap 1: the default state comes first and is never trimmed away (keys index the TRIMMED options)',
  tiny.keys[0] === c.comboKey([tiny.domains[0].defaultIndex, 0]) && tiny.domains[0].options[tiny.domains[0].defaultIndex] === 'a2');
ok('cap 1: the floor is the default + "All" for a control whose default is a value', tiny.keys.length === 2 && tiny.keys.includes('0.0'));
const allDefault = c.planCombos([dom('a', 5), dom('b', 5)], 1);
ok('cap 1 with "All" defaults: exactly one state', allDefault.keys.length === 1 && allDefault.keys[0] === '0.0');
const bad = c.planCombos([{ id: 'z', label: 'z', options: [], defaultIndex: 9 }], 10);
ok('a control with no options degrades to "All", never a crash', bad.keys.length === 1 && bad.domains[0].options[0] === 'All');
ok('the input domains are not mutated', big[0].options.length === 21);

// ── The dialog line ──────────────────────────────────────────────────────────
ok('summary: "12 control combinations · 2.1 MB"', c.summaryLine(12, 2.1 * 1024 * 1024) === '12 control combinations · 2.1 MB', c.summaryLine(12, 2.1 * 1024 * 1024));
ok('summary: one state reads "No filter bar"', c.summaryLine(1, 380 * 1024) === 'No filter bar · 380 KB');
ok('bytes: KB and B', c.formatBytes(2048) === '2 KB' && c.formatBytes(12) === '12 B');

finish();
