import { describe, expect, it } from 'vitest';
import { decodeQuestion, encodeQuestion, groupBy, questionTitle, ungroup, withField, withSplit, withValues, type Field, type Question } from './spec';

const F = (name: string, kind: Field['kind'], aggregation?: 'sum' | 'avg'): Field => ({ name, kind, type: kind === 'measure' ? 'number' : kind === 'date' ? 'date' : 'text', ...(aggregation ? { aggregation } : {}) });
const KINDS: Record<string, Field['kind']> = { region: 'dimension', segment: 'dimension', order_date: 'date', revenue: 'measure', discount: 'measure' };
const kindOf = (n: string) => KINDS[n];
const Q = (over: Partial<Question['encoding']> = {}, chartType = '', filters: Question['filters'] = []): Question => ({ chartType, encoding: { category: '', values: [], ...over }, filters });

describe('the question in the URL', () => {
  it('round-trips: chart type, encoding, filters — and a column name in any script', () => {
    const q = Q({ category: 'région 東京 🌍', grain: 'month', series: 'segment', values: [{ column: 'Umsatz €', aggregation: 'avg' }] }, 'line', [
      { type: 'filter', column: 'région 東京 🌍', op: 'in', values: ['Nord', 'Süd'] },
    ]);
    const raw = encodeQuestion(q);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/); // base64url: safe in a query string as it is
    expect(decodeQuestion(raw)).toEqual(q);
  });

  it('leaves out what is empty, so a short question is a short link', () => {
    expect(JSON.parse(atob(encodeQuestion(Q({ category: 'r', values: [] })).replace(/-/g, '+').replace(/_/g, '/')))).toEqual({ e: { category: 'r', values: [] } });
  });

  it('a link that is not a question is ignored (null), never thrown', () => {
    const b64 = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    for (const bad of [null, '', '!!!', 'eyJ', b64('not json'), b64('[]'), b64('{"e":1}'), b64('{"e":{"category":5,"values":[]}}'), b64('{"e":{"category":"a"}}'), 'A'.repeat(20_001)]) {
      expect(decodeQuestion(bad)).toBeNull();
    }
  });

  it('keeps only the shape Explore asks — a bad measure, an unknown aggregate, a grain off the list and foreign shelves are dropped', () => {
    const raw = btoa(JSON.stringify({
      t: 'column',
      e: { category: 'region', grain: 'fortnight', pivot: { rows: [] }, values: [{ column: 'revenue', aggregation: 'median' }, { column: '', aggregation: 'sum' }, { column: 'units', aggregation: 'max' }] },
      f: [{ type: 'filter', column: 'region', op: '=', value: 'East' }, { type: 'drop_column', column: 'x' }, 'junk'],
    }));
    expect(decodeQuestion(raw)).toEqual({
      chartType: 'column',
      encoding: { category: 'region', values: [{ column: 'units', aggregation: 'max' }] },
      filters: [{ type: 'filter', column: 'region', op: '=', value: 'East' }],
    });
  });
});

describe('a click on a field', () => {
  it('a measure joins what is shown, with the server’s aggregate, and a second click takes it out', () => {
    const one = withField(Q({ category: 'region' }), F('discount', 'measure', 'avg'), kindOf);
    expect(one.encoding.values).toEqual([{ column: 'discount', aggregation: 'avg' }]);
    const two = withField(one, F('revenue', 'measure', 'sum'), kindOf);
    expect(two.encoding.values.map((v) => v.column)).toEqual(['discount', 'revenue']);
    expect(withField(two, F('discount', 'measure', 'avg'), kindOf).encoding.values).toEqual([{ column: 'revenue', aggregation: 'sum' }]);
  });

  it('a dimension groups by it; a date groups by month; a second click stops grouping', () => {
    const byRegion = withField(Q({ values: [{ column: 'revenue', aggregation: 'sum' }] }), F('region', 'dimension'), kindOf);
    expect(byRegion.encoding).toEqual({ category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] });
    const byMonth = withField(byRegion, F('order_date', 'date'), kindOf);
    expect(byMonth.encoding).toMatchObject({ category: 'order_date', grain: 'month' });
    expect(withField(byMonth, F('order_date', 'date'), kindOf).encoding).toEqual({ category: '', values: [{ column: 'revenue', aggregation: 'sum' }] });
  });

  it('the split column clicked again stops splitting; grouping by it moves it off the split', () => {
    const split = Q({ category: 'region', series: 'segment', values: [{ column: 'revenue', aggregation: 'sum' }] });
    expect(withField(split, F('segment', 'dimension'), kindOf).encoding.series).toBeUndefined();
    expect(groupBy(split, F('segment', 'dimension'), kindOf).encoding).toEqual({ category: 'segment', values: [{ column: 'revenue', aggregation: 'sum' }] });
  });

  it('an axis of another kind goes back to the chart that suits it (CONTROL: the same kind keeps the pick)', () => {
    const bars = Q({ category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] }, 'bar');
    expect(groupBy(bars, F('order_date', 'date'), kindOf).chartType).toBe('');
    expect(groupBy(bars, F('segment', 'dimension'), kindOf).chartType).toBe('bar');
  });

  it('one measure to several, or a split added, goes back to the suiting chart (CONTROL: a swap of one measure keeps the pick)', () => {
    const one = Q({ category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] }, 'pareto');
    expect(withValues(one, [...one.encoding.values, { column: 'discount', aggregation: 'avg' }]).chartType).toBe('');
    expect(withField(one, F('discount', 'measure', 'avg'), kindOf).chartType).toBe('');
    expect(withValues(one, [{ column: 'discount', aggregation: 'avg' }]).chartType).toBe('pareto');
    expect(withSplit(one, 'segment')).toMatchObject({ chartType: '', encoding: { series: 'segment' } });
    const split = withSplit({ ...one, chartType: 'stacked_column' }, 'segment');
    expect(withSplit({ ...split, chartType: 'stacked_column' }, 'region').chartType).toBe('stacked_column');
  });

  it('ungrouping drops the date grain and any map regions with the axis', () => {
    expect(ungroup(Q({ category: 'order_date', grain: 'month', geo: { level: 'us_state' } })).encoding).toEqual({ category: '', values: [] });
  });
});

describe('the question in words', () => {
  it.each([
    [{ category: 'region', values: [{ column: 'revenue', aggregation: 'sum' }] }, 'Total revenue by region'],
    [{ category: 'order_date', grain: 'month', values: [{ column: 'discount', aggregation: 'avg' }] }, 'Average discount by month of order_date'],
    [{ category: 'region', series: 'segment', values: [{ column: 'revenue', aggregation: 'sum' }, { column: 'orders', aggregation: 'count' }] }, 'Total revenue and count of orders by region, split by segment'],
    [{ category: 'region', values: [{ column: 'a', aggregation: 'min' }, { column: 'b', aggregation: 'max' }, { column: 'c', aggregation: 'sum' }] }, 'Lowest a, highest b and total c by region'],
    [{ category: '', values: [{ column: 'revenue', aggregation: 'sum' }] }, 'New question'],
  ] as const)('%j → %s', (e, want) => {
    expect(questionTitle(e as never)).toBe(want);
  });
});
