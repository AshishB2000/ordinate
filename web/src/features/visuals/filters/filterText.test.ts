import { describe, expect, it } from 'vitest';
import { liveFilters } from './filterText';
import type { FilterStep } from '../encoding';

const U = '7d2c1f4e-1111-4222-8333-444455556666';
const F = { type: 'filter', column: 'city', op: '=', value: 'Paris' } as FilterStep;
const TERM = { type: 'term', term: U };
const FUTURE = { type: 'future_x', a: 1, nested: { b: [2] } };
// A kept step rides in the FilterStep[] a screen holds (the server's own shortcut: expandTerms is the one door that reads it).
const rows = (...steps: unknown[]) => steps as FilterStep[];

describe('liveFilters', () => {
  it('keeps a step it cannot edit — a glossary term, a step a newer release added — in place, the same object', () => {
    const out = liveFilters(rows(F, TERM, FUTURE));
    expect(out).toEqual([F, TERM, FUTURE]);
    expect(out[1]).toBe(TERM);
    expect(out[2]).toBe(FUTURE);
  });

  it('NEGATIVE CONTROL: a row still being set up (no operator) is still dropped, and a Prepare step is no filter', () => {
    expect(liveFilters(rows({ type: 'filter', column: 'city', op: '' }, TERM, { type: 'filter', op: '=' }, { type: 'dedupe' }))).toEqual([TERM]);
  });
});
