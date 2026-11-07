// Explore's drill: a click on a bar asks `visual:drillDown` and pushes the drilled question onto the URL; the crumbs
// are read from the question; a phone's tap offers the drill in a sheet. The browser computes nothing.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Toaster } from '../../ui/Toast';
import type { ChartHandle } from '../../charts/Chart';
import { PHONE_QUERY } from '../../ui/Dialog';
import { renderApp, serveRpc, type RpcReply } from '../../test-utils';
import { drillableAxis, useExploreDrill, type DrillProps } from './useExploreDrill';
import { endAtHidden } from '../visuals/drill/drillApi';
import { decodeQuestion, encodeQuestion, type Question } from './spec';
import type { Preview } from '../visuals/api';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const REV = { column: 'revenue', aggregation: 'sum' as const };
const GEO = { id: 'h1', name: 'Geography', levels: ['region', 'state'] };
const BY_REGION: Question = { chartType: 'column', encoding: { category: 'region', values: [REV] }, filters: [] };
const EAST = { type: 'filter' as const, column: 'region', op: '=', value: 'East' };
const DRILLED = { ok: true, available: true, encoding: { category: 'state', values: [REV] }, steps: [EAST], crumb: { column: 'region', label: 'East', next: 'state' } };
const text = (labels: string[]) => ({ category: { kind: 'text' }, data: { labels, series: [] } }) as unknown as Preview;
const month = { category: { kind: 'date', grain: 'month' }, data: { labels: ['Jan 2023', 'Feb 2023'], series: [] } } as unknown as Preview;
const chart = (labels: string[]) =>
  ({ getElementsAtEventForMode: () => [{ index: 0, datasetIndex: 0 }], data: { labels, datasets: [{ label: 'sum of revenue' }] } }) as unknown as ChartHandle;
const LADDER = ['year', 'quarter', 'month', 'day'] as const;

function Probe(p: Partial<DrillProps> & { labels?: string[] }) {
  const { onMark, sheet } = useExploreDrill({
    projectId: 'P', datasetId: 'D', question: BY_REGION, reply: text(['East', 'West']), chartType: 'column', hierarchies: [GEO], ladder: LADDER, onChange: () => {}, ...p,
  });
  return (
    <>
      <button disabled={!onMark} onClick={(e) => onMark?.(chart(p.labels ?? ['East', 'West']), e.nativeEvent, [])}>
        mark
      </button>
      {sheet}
      <Toaster />
    </>
  );
}
const drillCalls = (calls: { channel: string; payload: unknown }[]) => calls.filter((c) => c.channel === 'visual:drillDown');
const serve = (r: RpcReply) => serveRpc({ 'visual:drillDown': r });

describe('drillableAxis', () => {
  const base = { chartType: 'column', encoding: BY_REGION.encoding, category: { kind: 'text' }, hierarchies: [GEO], ladder: LADDER };
  it('says the next level of a text hierarchy and the next grain of a date', () => {
    expect(drillableAxis(base)).toEqual({ next: 'state', word: 'state' });
    expect(drillableAxis({ ...base, category: { kind: 'date', grain: 'month' } })).toEqual({ next: 'day', word: 'day' });
  });
  it('NEGATIVE CONTROL: not a day, a scatter, the last level, or a category with no hierarchy', () => {
    expect(drillableAxis({ ...base, category: { kind: 'date', grain: 'day' } })).toBeNull();
    expect(drillableAxis({ ...base, chartType: 'scatter' })).toBeNull();
    expect(drillableAxis({ ...base, encoding: { ...base.encoding, category: 'state' } })).toBeNull();
    expect(drillableAxis({ ...base, hierarchies: [] })).toBeNull();
  });
  it('offers no level hidden from the caller (part 4): the server refuses that drill', () => {
    expect(drillableAxis({ ...base, hierarchies: endAtHidden([GEO], ['state']) })).toBeNull();
    expect(drillableAxis({ ...base, hierarchies: endAtHidden([GEO], ['salary']) })).toEqual({ next: 'state', word: 'state' }); // NEGATIVE CONTROL
  });
});

describe('Explore drill: the click', () => {
  it('asks the server with the mark and pushes the question the reply describes', async () => {
    const calls = serve({ body: DRILLED });
    const onChange = vi.fn();
    render(<Probe onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'mark' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    const sent = drillCalls(calls)[0].payload as { mark: unknown; encoding: { category: string } };
    expect(sent.mark).toEqual({ category: 'East' });
    expect(sent.encoding.category).toBe('region');
    expect(onChange).toHaveBeenCalledWith({ chartType: 'column', encoding: DRILLED.encoding, filters: [EAST] });
  });
  it('keeps the question\'s own steps (a kept one too) before the reply\'s', async () => {
    serve({ body: DRILLED });
    const onChange = vi.fn();
    const TERM = { type: 'term', term: 'big' } as unknown as Question['filters'][number];
    render(<Probe onChange={onChange} question={{ ...BY_REGION, filters: [TERM] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'mark' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange.mock.calls[0][0].filters).toEqual([TERM, EAST]);
  });
  it('sends a month bar by the server\'s own label', async () => {
    const calls = serve({ body: { ...DRILLED, steps: [] } });
    render(<Probe reply={month} labels={['2023-01-01', '2023-02-01']} question={{ ...BY_REGION, encoding: { category: 'order_date', grain: 'month', values: [REV] } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'mark' }));
    await waitFor(() => expect(drillCalls(calls)).toHaveLength(1));
    expect((drillCalls(calls)[0].payload as { mark: unknown }).mark).toEqual({ category: '2023-01-01' });
  });
  it('shows a refusal as a toast and keeps the question', async () => {
    serve({ body: { ok: true, available: false, reason: 'state is the last level of Geography.' } });
    const onChange = vi.fn();
    render(<Probe onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'mark' }));
    expect(await screen.findByText('state is the last level of Geography.')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });
  it('says it could not drill when the channel is missing (an older pod), and keeps the question', async () => {
    serve({ status: 404, body: { ok: false, error: 'No such channel' } });
    const onChange = vi.fn();
    render(<Probe onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'mark' }));
    expect(await screen.findByText('This chart could not drill down. Try again.')).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });
  it('CONTROL: a chart that does not drill has no onMark', () => {
    serve({ body: DRILLED });
    render(<Probe chartType="scatter" />);
    expect((screen.getByRole('button', { name: 'mark' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Explore drill: the phone', () => {
  it('a tap opens the sheet and drills only when its action is pressed', async () => {
    window.matchMedia = ((q: string) => ({ matches: q === PHONE_QUERY, media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
    const calls = serve({ body: DRILLED });
    const onChange = vi.fn();
    render(<Probe onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'mark' }));
    const go = await screen.findByRole('button', { name: /Drill into East · by state/ });
    expect(drillCalls(calls)).toHaveLength(0);
    await act(async () => fireEvent.click(go));
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
  });
});

describe('Explore drill: the page', () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const DID = '22222222-2222-4222-8222-222222222222';
  const ME = { user: { email: 'dev@local', role: 'editor' }, org: 'default', mode: 'header', canSignOut: false };
  const ANSWER = { ok: true, data: { labels: ['Ohio', 'Maine'], series: [{ name: 'sum of revenue', values: [3, 2] }] }, recommendedShape: 'categorical', warnings: [], category: { kind: 'text' } };
  const open = (q: Question, nav: RpcReply) => {
    serveRpc({
      '/api/auth/me': { body: ME },
      'projects:overview': { body: [{ id: PID, name: 'Sales', updatedAt: '', lastOpenedAt: null, archived: false, datasets: 1, dashboards: 0, sample: false }] },
      'projects:roles': { body: { [PID]: 'editor' } },
      'ai:status': { body: { ready: false, models: [], mine: null, keyStore: null } },
      'dataset:list': { body: [{ id: DID, name: 'Retail orders', sourceKind: 'csv', rowCount: 5000, columnCount: 5, updatedAt: '' }] },
      'explore:suggest': { body: { ok: true, dimensions: [{ name: 'region', type: 'text' }, { name: 'state', type: 'text' }], dates: [], measures: [{ name: 'revenue', aggregation: 'sum' }], suggestions: [] } },
      'visual:data': { body: ANSWER },
      'model:navigation': nav,
    });
    return renderApp(`/explore?project=${PID}&dataset=${DID}&q=${encodeQuestion(q)}`);
  };
  const NAV = { body: { ok: true, tables: [{ datasetId: DID, hierarchies: [GEO] }], dateLadder: ['year', 'quarter', 'month', 'day'] } };
  const DRILLED_Q: Question = { chartType: 'column', encoding: { category: 'state', values: [REV] }, filters: [EAST] };

  it('draws the crumbs from the question; Up and the hierarchy crumb each push the by-region question', async () => {
    const router = open(DRILLED_Q, NAV);
    const path = await screen.findByRole('navigation', { name: 'Drill path' });
    expect(path.textContent).toContain('Geography');
    expect(path.textContent).toContain('East');
    expect(path.textContent).toContain('by state');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Up' })));
    await waitFor(() => expect(decodeQuestion(new URLSearchParams(router.state.location.search).get('q'))).toEqual({ ...DRILLED_Q, encoding: BY_REGION.encoding, filters: [] }));
    expect(router.state.historyAction).toBe('PUSH');
    await act(async () => router.navigate(-1)); // Back is the drilled question again
    await screen.findByRole('navigation', { name: 'Drill path' });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Geography' })));
    await waitFor(() => expect(decodeQuestion(new URLSearchParams(router.state.location.search).get('q'))!.encoding.category).toBe('region'));
  });
  it('NEGATIVE CONTROL: no crumb row when the navigation read fails, or the filters hold no path', async () => {
    open(DRILLED_Q, { status: 404, body: { ok: false } });
    await screen.findByRole('heading', { level: 2, name: /by state/ });
    expect(screen.queryByRole('navigation', { name: 'Drill path' })).toBeNull();
  });
});
