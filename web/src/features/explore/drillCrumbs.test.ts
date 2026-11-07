import { describe, expect, it } from 'vitest';
import { crumbsOf, upTo } from './drillCrumbs';
import type { Question } from './spec';

const REV = { column: 'revenue', aggregation: 'sum' as const };
const GEO = { id: 'h1', name: 'Geography', levels: ['region', 'state'] };
const GEO3 = { id: 'h2', name: 'Geography', levels: ['region', 'state', 'city'] };
const TERM = { type: 'term', term: 'big' } as unknown as Question['filters'][number];
const eq = (column: string, value: string) => ({ type: 'filter' as const, column, op: '=', value });
const Q: Question = { chartType: 'column', encoding: { category: 'state', values: [REV] }, filters: [TERM, eq('region', 'East')] };

describe('drill crumbs', () => {
  it('reads the path from the question, and Up keeps the chart type and kept steps', () => {
    expect(crumbsOf(Q, [GEO])!.map((c) => c.label)).toEqual(['Geography', 'East']);
    expect(crumbsOf(Q, [GEO])![1].to).toBeNull();
    expect(crumbsOf(Q, [GEO])![0].to).toEqual({ ...Q, encoding: { category: 'region', values: [REV] }, filters: [TERM] });
    const deep: Question = { ...Q, encoding: { ...Q.encoding, category: 'city' }, filters: [...Q.filters, eq('state', 'Ohio')] };
    expect(upTo(deep, GEO3, 1).filters).toEqual(Q.filters);
    expect(upTo(deep, GEO3, 1).encoding.category).toBe('state');
    expect(crumbsOf(deep, [GEO3])!.map((c) => c.label)).toEqual(['Geography', 'East', 'Ohio']);
    expect(crumbsOf(deep, [GEO3])![1].to).toEqual(upTo(deep, GEO3, 1));
  });
  it('a crumb shows the value label the drill was told (crumb.label), else the stored value', () => {
    const labelOf = (column: string, value: string) => (column === 'region' && value === 'East' ? 'Eastern region' : value);
    expect(crumbsOf(Q, [GEO], labelOf)!.map((c) => c.label)).toEqual(['Geography', 'Eastern region']);
    expect(crumbsOf({ ...Q, filters: [eq('region', 'West')] }, [GEO], labelOf)!.map((c) => c.label)).toEqual(['Geography', 'West']); // NEGATIVE CONTROL
  });
  it('NEGATIVE CONTROL: no crumbs when the filters do not hold one step per level above', () => {
    expect(crumbsOf({ ...Q, filters: [TERM] }, [GEO])).toBeNull();
    expect(crumbsOf({ ...Q, filters: [...Q.filters, eq('region', 'West')] }, [GEO])).toBeNull();
    expect(crumbsOf(Q, [{ ...GEO, missing: ['state'] }])).toBeNull();
    expect(crumbsOf({ ...Q, encoding: { ...Q.encoding, category: 'region' } }, [GEO])).toBeNull(); // top level
  });
});
