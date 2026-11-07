// A picker narrows by the controls on the higher levels of its hierarchy (p6-05). NEGATIVE CONTROLS: a control on no
// hierarchy, another dataset's control, an unset parent and a lower level all give no steps.
import { describe, expect, it } from 'vitest';
import type { Card } from '../api';
import { cascadeOf, type Sibling } from './cascade';

type Control = NonNullable<Card['control']>;
const D = '1b6b0e1c-2f0a-4b8e-9d34-1c2d3e4f5a6b';
const geo = [{ id: 'g', name: 'Geography', levels: ['region', 'state', 'city'] }];
const ctl = (column: string, kind: 'dropdown' | 'multi' = 'dropdown', datasetId = D, label = ''): Control => ({ kind, datasetId, column, label }) as Control;
const sib = (control: Control, value: Sibling['value']): Sibling => ({ control, value });
const state = ctl('state');

describe('cascadeOf', () => {
  it('narrows State by Region = West', () => {
    const c = cascadeOf(state, [sib(ctl('region', 'dropdown', D, 'Region'), { value: 'West' })], geo);
    expect(c).toEqual({ steps: [{ type: 'filter', column: 'region', op: '=', value: 'West' }], by: [{ label: 'Region', summary: 'West' }] });
  });
  it('a multi parent gives an in step', () => {
    const c = cascadeOf(state, [sib(ctl('region', 'multi'), { values: ['West', 'East'] })], geo);
    expect(c.steps).toEqual([{ type: 'filter', column: 'region', op: 'in', values: ['West', 'East'] }]);
    expect(c.by[0].summary).toBe('West, East');
  });
  it('orders parents by level, nearest last', () => {
    const c = cascadeOf(ctl('city'), [sib(ctl('state'), { value: 'CA' }), sib(ctl('region'), { value: 'West' })], geo);
    expect(c.steps.map((s) => s.column)).toEqual(['region', 'state']);
  });
  it('NEGATIVE: no hierarchy, another dataset, an unset parent, a lower level and the top level give none', () => {
    const none = { steps: [], by: [] };
    expect(cascadeOf(ctl('segment'), [sib(ctl('region'), { value: 'West' })], geo)).toEqual(none);
    expect(cascadeOf(state, [sib(ctl('region', 'dropdown', 'other'), { value: 'West' })], geo)).toEqual(none);
    expect(cascadeOf(state, [sib(ctl('region'), undefined)], geo)).toEqual(none);
    expect(cascadeOf(state, [sib(ctl('region'), { values: [] })], geo)).toEqual(none);
    expect(cascadeOf(state, [sib(ctl('city'), { value: 'LA' })], geo)).toEqual(none);
    expect(cascadeOf(ctl('region'), [sib(state, { value: 'CA' })], geo)).toEqual(none);
  });
  it('NEGATIVE: a hierarchy with a missing level is not walked', () => {
    expect(cascadeOf(state, [sib(ctl('region'), { value: 'West' })], [{ ...geo[0], missing: ['city'] }]).steps).toEqual([]);
  });
});
