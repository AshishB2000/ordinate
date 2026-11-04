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

  it('keeps a step\'s via and fromControl on the step it rebuilds', () => {
    const via = { ...F, via: U };
    const control = { type: 'filter', column: 'day', op: 'period', period: { preset: 'last_30_days' }, fromControl: true } as FilterStep;
    expect(JSON.stringify(liveFilters(rows(via, control)))).toBe(JSON.stringify([via, control]));
  });

  it('NEGATIVE CONTROL: a step without them gets neither key, byte-identical to today', () => {
    const out = liveFilters(rows(F, { type: 'filter', column: 'day', op: 'period', period: { preset: 'last_30_days' }, context: true }));
    expect(JSON.stringify(out)).toBe('[{"type":"filter","column":"city","op":"=","value":"Paris"},{"type":"filter","column":"day","op":"period","period":{"preset":"last_30_days"},"context":true}]');
  });
});
