// isKeptStep / keptKey MIRROR the server's rule (src/data/filterList.ts): the web may not import it
// (Buffer, the Prepare sanitizers), so this file holds the two together.

import { deepStrictEqual, notStrictEqual, strictEqual } from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'vitest';
import { PREPARE_STEP_TYPES, isKeptStep, keptKey, markScopeTerms } from './keptStep';

const ROOT = path.resolve(process.cwd(), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
// any: the server's modules are CommonJS
const server: any = require(path.join(ROOT, 'src', 'data', 'filterList.js'));
const transforms: any = require(path.join(ROOT, 'src', 'data', 'transforms.js'));
const { stableStringify }: any = require(path.join(ROOT, 'src', 'engine', 'queryCache.js'));

const U = '7d2c1f4e-1111-4222-8333-444455556666';
const TERM = { type: 'term', term: U };

describe('isKeptStep mirrors the server', () => {
  it('knows every Prepare step type the server does — a type added there fails here until it is added here', () => {
    deepStrictEqual([...PREPARE_STEP_TYPES].sort(), [...transforms.STEP_TYPES].sort());
  });

  it('agrees with what the server keeps in a filter list, for every shape', () => {
    // BIG (> MAX_KEPT_STEP_BYTES) is left out on purpose: the size gate is the server's, the web never sees a step it kept.
    const battery: unknown[] = [
      TERM, { type: 'future_x', a: 1, nested: { b: [2] } }, { type: 'filter', column: 'city', op: '=', value: 'Paris' }, { type: 'filter' },
      { type: 'dedupe' }, { type: 'drop_column', column: 'x' }, { type: 'segment' }, { type: 'calculated_field', name: 'n', expression: '1' },
      { type: 'Term' }, { type: 'a'.repeat(65) }, { type: 'a'.repeat(64) }, { type: '' }, { type: 5 }, { type: null }, {}, null, undefined, 'term', 7, ['term'],
    ];
    for (const x of battery) {
      const kept = server.sanitizeFilterList([x]).length === 1 && (x as { type?: unknown }).type !== 'filter';
      strictEqual(isKeptStep(x), kept, JSON.stringify(x));
    }
  });
});

describe('keptKey', () => {
  it('is the whole body, key order aside, and never a filter step’s key', () => {
    strictEqual(keptKey({ type: 'term', term: U, n: { b: 1, a: [2, { d: 1, c: 2 }] } }), keptKey({ n: { a: [2, { c: 2, d: 1 }], b: 1 }, term: U, type: 'term' }));
    notStrictEqual(keptKey(TERM), keptKey({ type: 'term', term: U.replace('7d', '7e') }));
    strictEqual(keptKey(TERM), 'kept:' + stableStringify(TERM)); // the server's own key
  });
});

describe('markScopeTerms mirrors the server', () => {
  it('marks a scope\'s well-formed terms only, as the server does', () => {
    const battery = [TERM, { ...TERM, fromControl: true }, { type: 'term' }, { type: 'filter', column: 'city', op: '=', value: 'Paris' }, { type: 'future_x' }];
    deepStrictEqual(markScopeTerms(battery), server.markScopeTerms(battery));
    deepStrictEqual(markScopeTerms([TERM]), [{ ...TERM, fromControl: true }]);
    strictEqual(markScopeTerms(battery)[3], battery[3]); // NEGATIVE CONTROL: a filter comes back as it was
  });
});
