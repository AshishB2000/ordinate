import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TreeNode } from './api';
import { nodeLabel, toneOf } from './NodeCard';
import { TreeEditor, describe as describeTree } from './TreeEditor';
import { TreeView } from './TreeView';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const node = (key: string, name: string, extra: Partial<TreeNode> = {}): TreeNode => ({
  key,
  kind: 'metric',
  name,
  current: 1,
  previous: 1,
  change: 0,
  pct: 0,
  display: `${name} now`,
  previousDisplay: `${name} before`,
  changeDisplay: '+0',
  pctDisplay: '',
  spark: null,
  children: [],
  ...extra,
});

/** Revenue = Orders × AOV; Orders split by region. The lead branch: Revenue → Orders → West. */
function sample(): TreeNode {
  return node('r', 'Revenue', {
    change: 10,
    direction: 'up_good',
    lead: true,
    changeDisplay: '+$10K',
    pctDisplay: '+5.0%',
    breakdown: { kind: 'product', text: 'Orders × Avg order value' },
    children: [
      node('r/o', 'Orders', {
        change: 3,
        direction: 'up_good',
        lead: true,
        contribution: 12,
        contributionDisplay: '+$12K',
        share: 120,
        shareDisplay: '120%',
        breakdown: { kind: 'split', text: 'by region' },
        children: [
          node('r/o:"West"', 'West', { kind: 'segment', lead: true, contribution: 3, contributionDisplay: '+3', shareDisplay: '100%' }),
          node('r/o:"East"', 'East', { kind: 'segment', contribution: 0, contributionDisplay: '+0', shareDisplay: '0%' }),
        ],
      }),
      node('r/a', 'Avg order value', { change: -1, direction: 'up_good', contribution: -2, contributionDisplay: '−$2K', share: -20, shareDisplay: '−20%' }),
      node('r:residual', 'Not explained by its parts', { kind: 'residual', contribution: 0.5, contributionDisplay: '+$0.5K', shareDisplay: '5%' }),
    ],
  });
}

describe('NodeCard words', () => {
  it('colours a move by the metric\'s direction, and only then', () => {
    expect(toneOf('up_good', 3)).toBe('good');
    expect(toneOf('up_good', -3)).toBe('bad');
    expect(toneOf('down_good', -3)).toBe('good');
    expect(toneOf(undefined, 3)).toBe('neutral');
    expect(toneOf('up_good', 0)).toBe('neutral');
    expect(toneOf('up_good', null)).toBe('neutral');
  });

  it('says a node\'s figures in one sentence, from the server\'s strings', () => {
    const o = sample().children[0];
    expect(nodeLabel(o)).toBe('Orders, Orders now, change +0 from Orders before, contributes +$12K, 120% of the change, explains most of the change');
  });
});

describe('TreeView', () => {
  it('draws every node the server sent, its contribution and the residual row', () => {
    render(<TreeView root={sample()} label="Revenue tree" />);
    const tree = screen.getByRole('tree', { name: 'Revenue tree' });
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(6);
    expect(screen.getByText('+$12K')).toBeTruthy();
    expect(screen.getByText('−20% of the change')).toBeTruthy();
    expect(screen.getByText('Not explained by its parts')).toBeTruthy();
    expect(screen.getByText('= Orders × Avg order value')).toBeTruthy();
    expect(screen.getByText('by region')).toBeTruthy();
  });

  it('marks the lead branch — and only it; a split\'s segments are rows of a list', () => {
    const { container } = render(<TreeView root={sample()} label="t" />);
    const lead = Array.from(container.querySelectorAll('[role="treeitem"]')).filter((el) => /lead(Card|Row)/.test(el.querySelector(':scope > [data-card]')?.className ?? ''));
    expect(lead.map((el) => el.getAttribute('data-key'))).toEqual(['r', 'r/o', 'r/o:"West"']);
    expect(container.querySelector('[data-key="r/o:\\"West\\""] > [data-card]')?.className).toMatch(/segRow/);
  });

  it('collapses and expands a node from its chevron', async () => {
    render(<TreeView root={sample()} label="t" />);
    expect(screen.getByText('West')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Orders' }));
    expect(screen.queryByText('West')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand Orders' }));
    expect(screen.getByText('West')).toBeTruthy();
  });

  it('opens two levels and the lead branch by default, not the rest', () => {
    const deep = sample();
    deep.children[1].children = [node('r/a/x', 'Deep part', { children: [node('r/a/x/y', 'Deeper')] })];
    render(<TreeView root={deep} label="t" />);
    expect(screen.getByText('Deep part')).toBeTruthy();
    expect(screen.queryByText('Deeper')).toBeNull();
  });

  it('is a keyboard tree: one tab stop, arrows move, ← closes and climbs, → opens and descends', () => {
    render(<TreeView root={sample()} label="t" />);
    const items = () => screen.getAllByRole('treeitem');
    expect(items().filter((el) => el.tabIndex === 0)).toHaveLength(1);
    const root = items()[0];
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('data-key')).toBe('r/o');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    expect((document.activeElement as HTMLElement).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('West')).toBeNull();
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    expect(document.activeElement?.getAttribute('data-key')).toBe('r');
    fireEvent.keyDown(document.activeElement as Element, { key: 'End' });
    expect(document.activeElement?.getAttribute('data-key')).toBe('r:residual');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Home' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(screen.getByText('West')).toBeTruthy();
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(document.activeElement?.getAttribute('data-key')).toBe('r/o:"West"');
    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' });
    expect(items().filter((el) => el.tabIndex === 0).map((el) => el.getAttribute('data-key'))).toEqual(['r/o:"West"']);
  });

  it('closing a node from its chevron keeps the tree in the tab order, focus on that node', () => {
    render(<TreeView root={sample()} label="t" />);
    const root = screen.getAllByRole('treeitem')[0];
    root.focus();
    fireEvent.keyDown(root, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('data-key')).toBe('r/o');
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Revenue' }));
    const stops = screen.getAllByRole('treeitem').filter((el) => el.tabIndex === 0);
    expect(stops.map((el) => el.getAttribute('data-key'))).toEqual(['r']);
    expect(document.activeElement?.getAttribute('data-key')).toBe('r');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowRight' });
    expect(screen.getByText('Orders')).toBeTruthy();
  });

  it('a note says why a node has no contributions', () => {
    const t = sample();
    t.children[1].note = 'Avg order value has no figure in one of the periods, so its parts cannot be weighed.';
    render(<TreeView root={t} label="t" />);
    expect(screen.getByText(/cannot be weighed/)).toBeTruthy();
  });
});

describe('TreeEditor', () => {
  const PID = '11111111-1111-4111-8111-111111111111';
  const REV = '22222222-2222-4222-8222-222222222222';
  const ORD = '33333333-3333-4333-8333-333333333333';
  const AOV = '44444444-4444-4444-8444-444444444444';
  const suggest = {
    ok: true,
    suggestions: { [REV]: [{ relation: 'product', from: 'Avg order value', children: [{ metricId: ORD }, { metricId: AOV }] }] },
    metrics: [{ id: REV, name: 'Revenue' }, { id: ORD, name: 'Orders' }, { id: AOV, name: 'Avg order value' }],
    columns: ['region', 'channel'],
  };

  function serve() {
    const saved: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const payload = init?.body ? (JSON.parse(String(init.body)) as { args: unknown[] }).args[0] : undefined;
        if (url.includes('metricTree%3Asuggest') || url.includes('metricTree:suggest')) return new Response(JSON.stringify(suggest), { status: 200 });
        if (url.includes('metricTree%3Asave') || url.includes('metricTree:save')) {
          saved.push(payload);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response('null', { status: 200 });
      }),
    );
    return saved;
  }

  it('offers the breakdown read from a formula, and saves it on one click', async () => {
    const saved = serve();
    const onSaved = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TreeEditor projectId={PID} metricId={REV} metricName="Revenue" initial={null} open onOpenChange={() => {}} onSaved={onSaved} />
      </QueryClientProvider>,
    );
    const idea = await screen.findByRole('button', { name: /Orders × Avg order value/ });
    expect(idea.textContent).toContain('from Avg order value');
    fireEvent.click(idea);
    expect(screen.getAllByText('Not broken down')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Save tree' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    const body = saved[0] as { tree: { metricId: string; relation: string; children: { metricId: string }[] } };
    expect(body.tree.metricId).toBe(REV);
    expect(body.tree.relation).toBe('product');
    expect(body.tree.children.map((c) => c.metricId)).toEqual([ORD, AOV]);
    expect(onSaved).toHaveBeenCalled();
  });

  it('describes a breakdown in the editor\'s words', () => {
    const name = (id: string) => ({ a: 'Revenue', b: 'Cost' })[id] ?? '?';
    expect(describeTree({ id: '', metricId: '', relation: 'sum', children: [{ id: '', metricId: 'a' }, { id: '', metricId: 'b', negative: true }] }, name)).toBe('Revenue − Cost');
    expect(describeTree({ id: '', metricId: '', split: 'region' }, name)).toBe('Split by region');
    expect(describeTree({ id: '', metricId: '' }, name)).toBe('');
  });
});
