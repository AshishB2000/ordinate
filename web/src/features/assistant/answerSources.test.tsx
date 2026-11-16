// "Answered from ▾" and "Also on ▸" on an answer card (./AnswerSources): what the server says of the answer's source,
// formatted — the dataset's page only when the server sends it, where the rows come from only for an editor, Live,
// the filters, the time, the verified question — and the dashboards on the same dataset, asked only when that menu
// opens: loading, the list (drafts marked, "and N more"), none, a failure with a retry.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { AnswerCard, type Card } from './AnswerCard';

vi.mock('../../charts/Chart', () => ({ Chart: ({ label }: { label?: string }) => <div role="img" aria-label={label ?? 'Chart'} /> }));
vi.mock('../projects/api', () => ({ useCanEdit: () => false, useRoles: () => ({ data: undefined }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const SPEC = { datasetId: DID, category: 'region', measures: [{ column: 'amount', aggregation: 'sum' }], filters: [], chartType: 'column', title: 'Revenue by region' };
const base: Card = {
  ok: true, title: 'Revenue by region', chartType: 'column', datasetName: 'Sales',
  data: { labels: ['West', 'East'], series: [{ name: 'sum of Revenue', values: [3, 2] }] }, caption: 'West leads.',
  headline: [], bullets: [], chips: [], filterLabels: ['region = West'], notes: [],
  asOf: { at: '2026-11-15T01:00:00Z', mode: 'extract' }, uses: ['sum of Revenue', 'region'],
};
const EDITOR: Card = { ...base, answeredFrom: { datasetId: DID, origin: 'Connection · Warehouse · ANALYTICS.RETURNS' } };
const VIEWER: Card = { ...base, answeredFrom: { datasetId: DID } };

/** Each channel answers with a body, or what a function of the payload returns (a promise holds it open). */
function serve(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const channel = decodeURIComponent(url.split('?')[0].slice('/api/rpc/'.length));
    calls.push(channel);
    const r = routes[channel];
    const body = typeof r === 'function' ? await (r as () => unknown)() : r;
    return new Response(JSON.stringify(body ?? null), { status: 200 });
  }));
  return calls;
}

function draw(card: Card) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AnswerCard projectId={PID} spec={SPEC} card={card} narrated={false} onFollowUp={async () => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

/** A fact line of the open menu: its value's text, or null when the menu has no such line. */
const fact = (panel: HTMLElement, label: string): string | null => {
  const dt = within(panel).queryByText(label, { selector: 'dt' });
  return dt ? (dt.nextElementSibling?.textContent ?? '') : null;
};
const openAnswered = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Answered from Sales' }));
  return screen.getByRole('dialog', { name: 'Answered from Sales' });
};

describe('Answered from', () => {
  it('names the dataset in the meta row, and asks nothing to draw', () => {
    const calls = serve({});
    draw(EDITOR);
    expect(screen.getByTestId('answered-from').textContent).toBe('Answered fromSales');
    expect(calls).toEqual([]);
  });

  it('an editor reads the page link, where the rows come from, what it uses, its filters and time', () => {
    serve({});
    draw(EDITOR);
    const panel = openAnswered();
    expect(within(panel).getByRole('link', { name: 'Sales' }).getAttribute('href')).toBe(`/data/${PID}/${DID}`);
    expect(fact(panel, 'Rows from')).toBe('Connection · Warehouse · ANALYTICS.RETURNS');
    expect(fact(panel, 'Uses')).toBe('sum of Revenue, region');
    expect(fact(panel, 'Filters')).toBe('region = West');
    expect(fact(panel, 'Figures')).toMatch(/^As of /);
    expect(fact(panel, 'Verified question')).toBeNull();
    expect(panel.contains(document.activeElement)).toBe(true); // focus moved in: the keyboard reaches the link
  });

  it('a viewer reads the dataset alone: no line about its source', () => {
    serve({});
    draw(VIEWER);
    const panel = openAnswered();
    expect(within(panel).getByRole('link', { name: 'Sales' })).toBeTruthy();
    expect(fact(panel, 'Rows from')).toBeNull();
    expect(panel.textContent).not.toMatch(/ANALYTICS|Connection/);
  });

  it('no page from the server: the name, not a link; no filter says None', () => {
    serve({});
    draw({ ...base, filterLabels: [] });
    const panel = openAnswered();
    expect(within(panel).queryByRole('link')).toBeNull();
    expect(fact(panel, 'Dataset')).toBe('Sales');
    expect(fact(panel, 'Filters')).toBe('None');
  });

  it('a Live answer says Live; a verified one its question; a kept one the days of its period and its kept time', () => {
    serve({});
    draw({
      ...EDITOR, asOf: { at: '2026-11-15T02:05:00Z', mode: 'live' },
      verified: { id: 'q1', question: 'Revenue by region', by: 'ana@acme.test', at: '2026-11-01T00:00:00Z' },
      snapshot: { asOf: '2026-11-15T09:10:00Z', periods: [{ name: 'Yesterday', from: '2026-11-14', to: '2026-11-14' }] },
    });
    const panel = openAnswered();
    expect(fact(panel, 'Dataset')).toBe('SalesLive');
    expect(fact(panel, 'Verified question')).toBe('Revenue by region');
    expect(fact(panel, 'Filters')).toBe('region = West · Yesterday: Nov 14, 2026');
    expect(within(panel).getByTestId('as-of').getAttribute('datetime')).toBe('2026-11-15T09:10:00Z');
    expect(fact(panel, 'Figures')).toMatch(/^Live · /);
  });

  it('Escape closes it and focus returns to the trigger', async () => {
    serve({});
    draw(EDITOR);
    const trigger = screen.getByRole('button', { name: 'Answered from Sales' });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe('Also on', () => {
  const openAlso = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Also on dashboards' }));
    return screen.getByRole('dialog', { name: 'Also on' });
  };

  it('asks nothing until opened, then shows a skeleton, then the dashboards as links, drafts marked, and how many more', async () => {
    let release: (v: unknown) => void = () => undefined;
    const calls = serve({
      'answer:alsoOn': () => new Promise((r) => (release = r)),
    });
    draw(EDITOR);
    expect(calls).toEqual([]);
    const panel = openAlso();
    expect(within(panel).getByRole('status', { name: 'Finding dashboards' })).toBeTruthy();
    await act(async () => release({ ok: true, dashboards: [{ id: 'a1', name: 'Revenue review' }, { id: 'a2', name: 'Q4 plan', draft: true }], more: 2 }));
    const links = await within(panel).findAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Revenue review', `/analyses/${PID}/a1`],
      ['Q4 plan' + 'Draft', `/analyses/${PID}/a2`],
    ]);
    expect(within(panel).getByText('and 2 more')).toBeTruthy();
    expect(calls).toEqual(['answer:alsoOn']);
  });

  it('none: "Not on any dashboard yet"', async () => {
    serve({ 'answer:alsoOn': { ok: true, dashboards: [], more: 0 } });
    draw(VIEWER);
    const panel = openAlso();
    expect(await within(panel).findByText('Not on any dashboard yet')).toBeTruthy();
    expect(within(panel).queryByText(/more$/)).toBeNull();
  });

  it('a failure says so with the server\'s sentence, and Retry asks again', async () => {
    let fail = true;
    const calls = serve({ 'answer:alsoOn': () => (fail ? { ok: false, reason: 'This dataset is no longer in the project.' } : { ok: true, dashboards: [{ id: 'a1', name: 'Revenue review' }], more: 0 }) });
    draw(EDITOR);
    const panel = openAlso();
    expect(await within(panel).findByText('This dataset is no longer in the project.')).toBeTruthy();
    fail = false;
    fireEvent.click(within(panel).getByRole('button', { name: /Retry|Try again/ }));
    expect(await within(panel).findByRole('link', { name: 'Revenue review' })).toBeTruthy();
    expect(calls).toEqual(['answer:alsoOn', 'answer:alsoOn']);
  });
});
