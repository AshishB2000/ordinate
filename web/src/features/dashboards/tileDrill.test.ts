// A tile's drill is the reader's view state beside its narrowing: never saved, never on another tile, gone when a
// saved view is applied. `tileFilters` appends its steps, `drilledDef` swaps in the drilled encoding.

import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import type { EditorApi } from '../analyses/editor/context';
import type { Step, VisualDef } from '../analyses/api';
import { tileFilters } from './CardRuntime';
import { drilledDef, drillSteps, type TileDrill, type TileDrillLevel } from './tileDrill';
import { useViewer } from './useViewer';
import { useTileDrill } from './useTileDrill';
import { serveRpc } from '../../test-utils';
import type { Card } from '../analyses/api';

const REV = { column: 'revenue', aggregation: 'sum' };
const def = { id: 'v', name: 'Revenue', datasetId: 'D', chartType: 'column', encoding: { category: 'region', values: [REV] }, overrides: {}, filters: [], updatedAt: '' } as VisualDef;
const eq = (column: string, value: string): Step => ({ type: 'filter', column, op: '=', value });
const L1: TileDrillLevel = { encoding: { category: 'state', values: [REV] }, steps: [eq('region', 'East')], crumb: { label: 'East', next: 'state', word: 'state' } };
const L2: TileDrillLevel = { encoding: { category: 'city', values: [REV] }, steps: [eq('state', 'Ohio')], crumb: { label: 'Ohio', next: 'city', word: 'city' } };
const wrap = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: new QueryClient() }, children);

describe('drilledDef and drillSteps', () => {
  it('no drill is the same object; two levels read the last encoding and both levels\' steps in order', () => {
    expect(drilledDef(def, undefined)).toBe(def);
    expect(drillSteps(undefined)).toEqual([]);
    const d: TileDrill = { root: 'Geography', levels: [L1, L2] };
    expect(drilledDef(def, d).encoding).toBe(L2.encoding);
    expect(drilledDef(def, d).name).toBe('Revenue');
    expect(drillSteps(d)).toEqual([...L1.steps, ...L2.steps]);
  });
});

describe('the viewer’s drills', () => {
  const view = () => renderHook(() => useViewer('P', 'A'), { wrapper: wrap });

  it('drills one tile only, steps up by level, and a saved view clears every drill', () => {
    const { result } = view();
    act(() => result.current.drillInto('A', 'Geography', L1));
    act(() => result.current.drillInto('A', 'Geography', L2));
    expect(result.current.drills.get('A')).toEqual({ root: 'Geography', levels: [L1, L2] });
    // NEGATIVE CONTROL: another tile has neither a drill nor a narrowing from it.
    expect(result.current.drills.get('B')).toBeUndefined();
    expect(result.current.tileSteps('B')).toEqual([]);
    act(() => result.current.drillUp('A', 1));
    expect(result.current.drills.get('A')?.levels).toEqual([L1]);
    act(() => result.current.drillUp('A', 0));
    expect(result.current.drills.has('A')).toBe(false);
    act(() => result.current.drillInto('A', 'Geography', L1));
    act(() => result.current.drillInto('C', 'All dates', L1));
    act(() => result.current.restore([], new Map(), null));
    expect(result.current.drills.size).toBe(0);
  });

  it('tileFilters ends with the tile’s own drill steps and leaves every other tile unchanged', () => {
    const { result } = view();
    const ed = () => ({ view: result.current, filtersFor: () => [eq('year', '2024')] }) as unknown as EditorApi;
    const before = tileFilters(ed(), 'B');
    act(() => result.current.drillInto('A', 'Geography', L1));
    act(() => result.current.drillInto('A', 'Geography', L2));
    expect(tileFilters(ed(), 'A')).toEqual([eq('year', '2024'), ...L1.steps, ...L2.steps]);
    expect(tileFilters(ed(), 'B')).toEqual(before);
  });
});

describe('a drilled tile\'s freshness', () => {
  it('keeps its levels fresh for a minute while drilled (Up asks nothing), and drops that once it is back at the root', async () => {
    const DRILLED = { ok: true, available: true, encoding: L1.encoding, steps: L1.steps, crumb: { column: 'region', label: 'East', next: 'state' } };
    serveRpc({ 'model:navigation': { body: { ok: true, tables: [{ datasetId: 'D', hierarchies: [{ id: 'h', name: 'Geography', levels: ['region', 'state'] }] }], dateLadder: ['year', 'month', 'day'], topics: [] } }, 'visual:drillDown': { body: DRILLED } });
    const v = renderHook(() => useViewer('P', 'A'), { wrapper: wrap });
    const ed = () => ({ projectId: 'P', viewing: true, view: v.result.current, params: {}, filtersFor: () => [] }) as unknown as EditorApi;
    const t = renderHook(() => useTileDrill(ed(), { id: 'A' } as Card, def), { wrapper: wrap });
    expect(t.result.current.staleTime).toBeUndefined();
    const offer = await act(() => t.result.current.offer({ category: 'East', shown: 'East', time: false }));
    act(() => offer!.run());
    await waitFor(() => expect(v.result.current.drills.has('A')).toBe(true));
    t.rerender();
    expect(t.result.current.staleTime).toBe(60_000);
    act(() => v.result.current.drillUp('A', 0));
    t.rerender();
    expect(t.result.current.staleTime).toBe(60_000); // the Up itself redraws the cached root
    t.rerender();
    expect(t.result.current.staleTime).toBeUndefined();
  });
});
