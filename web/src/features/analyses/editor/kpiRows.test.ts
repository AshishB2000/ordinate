import { describe, expect, it } from 'vitest';
import type { Card } from '../api';
import { kpiDrillTarget } from './MetricCard';

const ED = {
  projectId: '11111111-1111-4111-8111-111111111111',
  filters: [{ type: 'filter', column: 'region', op: '=', value: 'East' }],
  params: [{ name: 'rate', kind: 'number', value: 2 }],
};
const DS = '22222222-2222-4222-8222-222222222222';
const card = (metric: Card['metric']): Card => ({ id: 'c1', type: 'metric', layout: { x: 0, y: 0, w: 3, h: 2 }, metric }) as Card;

describe('the rows behind a KPI', () => {
  it('asks for the dataset under the SAME filters and parameters the card read, with no mark', () => {
    expect(kpiDrillTarget(ED, card({ datasetId: DS, column: 'revenue', aggregation: 'sum', label: 'Revenue' }))).toEqual({
      name: 'Revenue',
      projectId: ED.projectId,
      datasetId: DS,
      encoding: { values: [{ column: 'revenue', aggregation: 'sum' }] },
      filters: ED.filters,
      mark: null,
      description: 'The rows behind this figure',
      params: ED.params,
    });
  });

  it('a saved metric goes by id, for the server to add its own filters', () => {
    const metricId = '33333333-3333-4333-8333-333333333333';
    expect(kpiDrillTarget(ED, card({ datasetId: DS, column: 'revenue', aggregation: 'sum', metricId }))?.metricId).toBe(metricId);
  });

  it('NEGATIVE CONTROL: a card with no metric has no rows to ask for', () => {
    expect(kpiDrillTarget(ED, card(undefined))).toBeNull();
  });
});
