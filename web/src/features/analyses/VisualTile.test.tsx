import { deepStrictEqual } from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeFilters } from './VisualTile';

const ROOT = path.resolve(process.cwd(), '..');
const require = createRequire(path.join(ROOT, 'package.json'));
// any: the server's module is CommonJS
const server: any = require(path.join(ROOT, 'src', 'analysis', 'dashboardFilters.js'));

const U = '7d2c1f4e-1111-4222-8333-444455556666';
const V = '8e3d2a5f-2222-4333-9444-555566667777';
const F = { type: 'filter', column: 'city', op: '=', value: 'Paris' };
const G = { type: 'filter', column: 'year', op: '>=', value: 2024 };
const TERM = { type: 'term', term: U };
const FUTURE = { type: 'future_x', a: 1 };

describe('mergeFilters keeps what the web cannot edit', () => {
  it('a term once, in place, never folded into a filter', () => {
    expect(mergeFilters([TERM], [TERM, F])).toEqual([TERM, F]);
    expect(mergeFilters([TERM, F], [F, { ...TERM }, FUTURE])).toEqual([TERM, F, FUTURE]);
  });

  it('two different terms are two steps; one term written with its keys the other way round is one', () => {
    expect(mergeFilters([TERM], [{ type: 'term', term: V }])).toHaveLength(2);
    expect(mergeFilters([{ type: 'term', term: U, a: 1, b: 2 }], [{ b: 2, a: 1, term: U, type: 'term' }])).toHaveLength(1);
  });

  it('NEGATIVE CONTROL: a Prepare step or junk in a filter list is still dropped', () => {
    expect(mergeFilters([{ type: 'dedupe' }, F], [{ type: 'filter' }, null as never]).map((s) => s.type)).toEqual(['filter', 'filter']);
  });

  it('keeps a dashboard filter and a tile\'s same filter through a relationship, both', () => {
    expect(mergeFilters([F], [{ ...F, via: V }])).toEqual([F, { ...F, via: V }]);
    expect(mergeFilters([F], [{ ...F }])).toEqual([F]); // NEGATIVE CONTROL: without via, one
  });

  it('agrees with the server’s mergeDashboardFilters', () => {
    const lists: unknown[][] = [[], [TERM], [F, TERM, G], [TERM, TERM, FUTURE], [{ type: 'term', term: V }, F], [{ type: 'dedupe' }, null, F], [{ ...F, via: V }, G]];
    for (const a of lists) for (const b of lists) deepStrictEqual(mergeFilters(a as never, b as never), server.mergeDashboardFilters(a, b), JSON.stringify([a, b]));
  });
});
