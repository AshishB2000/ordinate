import { describe, expect, it } from 'vitest';
import { carrySteps, type TileAction } from './tileActions';
import { stepKey } from './useViewer';

const U = '7d2c1f4e-1111-4222-8333-444455556666';
const V = '8e3d2a5f-2222-4333-9444-555566667777';
const F = { type: 'filter', column: 'region', op: '=', value: 'West' };
const TERM = { type: 'term', term: U };
const FUTURE = { type: 'future_x', a: 1 };
const all = { kind: 'navigate', carry: 'all_selection' } as TileAction;

describe('carrySteps keeps what the web cannot edit', () => {
  it('a term travels whole, in place, once — before the click', () => {
    expect(carrySteps(all, null, [TERM])).toEqual([TERM]);
    const click = { column: 'region', value: 'East' };
    expect(carrySteps(all, click, [F, TERM, FUTURE, { ...TERM }])).toEqual([TERM, FUTURE, { type: 'filter', column: 'region', op: '=', value: 'East' }]);
  });

  it('two different terms are two steps', () => {
    expect(carrySteps(all, null, [TERM, { type: 'term', term: V }])).toHaveLength(2);
  });

  it('NEGATIVE CONTROL: a Prepare step still stays behind, and "clicked value" / "none" carry no term', () => {
    expect(carrySteps(all, null, [{ type: 'dedupe' }, TERM])).toEqual([TERM]);
    expect(carrySteps({ ...all, carry: 'clicked_value' }, null, [TERM])).toEqual([]);
    expect(carrySteps({ ...all, carry: 'none' }, null, [TERM])).toEqual([]);
  });
});

describe('stepKey', () => {
  it('keys a kept step by its whole body, apart from every filter step', () => {
    expect(stepKey(TERM)).not.toBe(stepKey({ type: 'term', term: V }));
    expect(stepKey(TERM)).not.toBe(stepKey(FUTURE));
    expect(stepKey(TERM)).not.toBe(stepKey({ type: 'filter' })); // a filter with nothing set
    expect(stepKey(TERM)).toBe(stepKey({ term: U, type: 'term' }));
  });
});
