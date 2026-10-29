// Where a ⌘K record hit opens: a dashboard opens itself, and a saved view opens
// its dashboard on it (`?view=`, the parent is the dashboard) — not the
// dashboards list, where both used to land.

import { describe, expect, it } from 'vitest';
import { hitHref } from './records';

const P = '11111111-1111-4111-8111-111111111111';
const A = '33333333-3333-4333-8333-333333333333';
const V = '77777777-7777-4777-8777-777777777771';

describe('a ⌘K hit’s route', () => {
  it('a dashboard opens itself', () => {
    expect(hitHref({ kind: 'analysis', id: A, projectId: P })).toBe(`/analyses/${P}/${A}`);
  });

  it('a saved view opens its dashboard on it', () => {
    expect(hitHref({ kind: 'view', id: V, parentId: A, projectId: P })).toBe(`/analyses/${P}/${A}?view=${V}`);
  });

  it('NEGATIVE CONTROL: a view hit with no dashboard named lands on the list, not a broken route', () => {
    expect(hitHref({ kind: 'view', id: V, projectId: P })).toBe('/dashboards');
  });

  it('other kinds are unchanged', () => {
    expect(hitHref({ kind: 'dataset', id: A, projectId: P })).toBe(`/data/${P}/${A}`);
    expect(hitHref({ kind: 'report', id: A, projectId: P })).toBe('/reports');
  });
});
