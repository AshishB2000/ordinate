// The grids against the desktop and against the a11y bar.
//
//   parity   the desktop renderers (its pivotRender.js and cohortRender.js)
//            and this port draw the SAME server replies — the sample dataset
//            through the server's own parseFile + buildVizData — and must
//            produce the same tables. The desktop side, replies included, was
//            recorded at the T8.1 cutover (__golden__/grids.json): every cell's tag, text, spans, kind
//            (subtotal / grand / total / base / blank / above / below) and
//            inline paint, plus the same surrounding text. One deliberate
//            difference: the port adds `scope` (the desktop pivot had none).
//   a11y     every <th> carries a scope that matches its place, every table
//            has an accessible name, and the a11y tree sees column and row
//            headers.
//   math     a printed total is the server's: `members` is shown, never the
//            sum of the sizes (a reply whose members disagree proves it).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { golden } from '../../test-golden';
import { SAMPLE_ENCODINGS } from '../sampleEncodings';
import type { Cx } from '../types';
import E from './Engine.module.css';
import { GridViz, type GridData } from './GridViz';
import { engineRows, type PivotGridShape } from './model';
import P from './Pivot.module.css';
import { GRID_STRINGS, t } from './strings';

const ROOT = path.resolve(process.cwd(), '..');

// The tokens both sides read (the cohort ramp mixes --surface → --accent).
const THEME: Record<string, string> = { '--surface': '#ffffff', '--accent': '#2563eb', '--text': '#374151', '--text-strong': '#0f1117' };
vi.mock('../palette', () => ({ getCSSVar: (name: string) => THEME[name] ?? '' }));

// ── The data: what `visual:data` answers ─────────────────────────────────────

const m = (column: string, aggregation = 'sum') => ({ column, aggregation });
const CASES: Record<string, { type: string; encoding: Cx }> = {
  'pivot / sample': { type: 'pivot', encoding: SAMPLE_ENCODINGS.pivot },
  'pivot / hierarchy, two values, scale + bars': {
    type: 'pivot',
    encoding: {
      category: 'region',
      values: [m('revenue')],
      pivot: {
        rows: [{ column: 'region' }, { column: 'category' }],
        columns: [{ column: 'customer_segment' }],
        values: [m('revenue'), m('profit')],
        totals: { rows: true, columns: true, grand: true },
        conditional: [{ valueIdx: 0, kind: 'scale' }, { valueIdx: 1, kind: 'bars' }],
      },
    },
  },
  'pivot / three levels, avg, % of total, threshold, sorted': {
    type: 'pivot',
    encoding: {
      category: 'region',
      values: [m('revenue')],
      pivot: {
        rows: [{ column: 'region' }, { column: 'category' }, { column: 'sub_category' }],
        columns: [],
        values: [{ ...m('revenue', 'avg'), showAs: 'pct_total' }, { ...m('units'), format: 'thousands' }],
        totals: { rows: false, columns: true, grand: false },
        conditional: [{ valueIdx: 1, kind: 'threshold', threshold: 400 }],
        sort: { by: 1, dir: 'desc' },
      },
    },
  },
  'pivot / two column levels, rank, table calc': {
    type: 'pivot',
    encoding: {
      category: 'region',
      values: [m('revenue')],
      pivot: {
        rows: [{ column: 'region' }],
        columns: [{ column: 'category' }, { column: 'customer_segment' }],
        values: [{ ...m('revenue'), showAs: 'rank' }, { ...m('profit'), calc: { kind: 'pct_of_total' } }],
        totals: { rows: true, columns: false, grand: false },
      },
    },
  },
  'cohort / retention table': { type: 'cohort', encoding: { ...SAMPLE_ENCODINGS.cohort, cohort: { ...(SAMPLE_ENCODINGS.cohort.cohort as object), curve: false } } },
  'cohort / value per member, monthly': {
    type: 'cohort',
    encoding: { ...SAMPLE_ENCODINGS.cohort, cohort: { entity: 'state', date: 'order_date', grain: 'month', show: 'value', value: 'revenue', curve: false } },
  },
  'event funnel / sample': { type: 'event_funnel', encoding: SAMPLE_ENCODINGS.event_funnel },
  'event funnel / breakdown by region': {
    type: 'event_funnel',
    encoding: { ...SAMPLE_ENCODINGS.event_funnel, eventFunnel: { ...(SAMPLE_ENCODINGS.event_funnel.eventFunnel as object), breakdown: 'region' } },
  },
  'cohort / needs a column': { type: 'cohort', encoding: { category: 'order_date', values: [m('revenue')], cohort: { entity: '', date: 'order_date', grain: 'month', show: 'retention', curve: false } } },
};

type Drawn = { tables: ReturnType<typeof tables>; text: string; funnel: ReturnType<typeof funnelSteps> };
const G = golden<{ data: Record<string, GridData>; drawn: Record<string, Drawn> }>('src/charts/grids/__golden__/grids.json');
const DATA: Record<string, GridData> = G.data;

// ── Normalising both sides into plain data ───────────────────────────────────

const KINDS: Array<[string, string]> = [
  ['is-subtotal', P.subtotal!], ['pivot-grand', P.grand!], ['pivot-total-cell', P.totalCell!], ['pivot-total-head', P.totalHead!],
  ['pivot-corner', P.corner!], ['is-above', P.above!], ['is-below', P.below!],
  ['is-base', E.base!], ['is-blank', E.blank!], ['ch-avg', E.avg!], ['ch-size', E.size!], ['ch-label', E.label!], ['ch-corner', E.corner!],
];

function kindsOf(el: Element, legacySide: boolean): string {
  const cls = el.classList;
  return KINDS.filter(([old, port]) => cls.contains(legacySide ? old : port)).map(([old]) => old).sort().join(' ');
}

/** Visible text: the port's screen-reader-only header label (the one a11y addition) is not on screen. */
function text(el: Element | null): string {
  if (!el) return '';
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('.' + P.srOnly).forEach((n) => n.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function tables(root: HTMLElement, legacySide: boolean) {
  return [...root.querySelectorAll('table')].map((table) =>
    [...table.querySelectorAll('tr')]
      .filter((tr) => !tr.className.includes('spacer') && !tr.classList.contains(P.spacer!))
      .map((tr) => ({
        kind: kindsOf(tr, legacySide),
        cells: [...tr.children].map((c) => {
          const cell = c as HTMLTableCellElement;
          return {
            tag: cell.tagName,
            text: text(cell),
            colSpan: cell.colSpan,
            rowSpan: cell.rowSpan,
            kind: kindsOf(cell, legacySide),
            background: cell.style.background,
            backgroundColor: cell.style.backgroundColor,
            color: cell.style.color,
            paddingLeft: cell.style.paddingLeft,
            title: cell.title,
          };
        }),
      })),
  );
}

function funnelSteps(root: HTMLElement) {
  return [...root.querySelectorAll('li')].map((li) => ({
    label: li.getAttribute('aria-label'),
    text: text(li),
    width: (li.querySelector('[aria-hidden="true"] > div') as HTMLElement | null)?.style.width,
  }));
}

function drawPort(type: string, data: GridData, interactive: boolean): HTMLElement {
  const { container } = render(
    <GridViz type={type} data={data} label="Grid" onSort={interactive ? () => {} : undefined} exportData={async () => data} />,
  );
  return container;
}

describe('parity with the desktop renderers, on the server’s replies', () => {
  for (const [name, c] of Object.entries(CASES)) {
    for (const interactive of c.type === 'pivot' ? [true, false] : [true]) {
      it(`${name}${c.type === 'pivot' ? (interactive ? ' (sortable)' : ' (read-only)') : ''}`, () => {
        const data = DATA[name]!;
        const old = G.drawn[`${name}|${interactive}`]!;
        expect(old, 'recorded').toBeTruthy();
        const port = drawPort(c.type, data, interactive);
        const b = tables(port, false);
        expect(b).toEqual(old.tables);
        if (c.type !== 'cohort' || !name.includes('needs')) expect(text(port)).toBe(old.text);
        if (c.type === 'event_funnel') expect(funnelSteps(port)).toEqual(old.funnel);
      });
    }
  }

  it('really compared something', () => {
    const shapes = Object.keys(CASES).map((name) => G.drawn[`${name}|true`]!.tables);
    const cells = shapes.flat(2).reduce((n, row) => n + row.cells.length, 0);
    expect(cells).toBeGreaterThan(700);
    // The hierarchy case has subtotal rows, the calc case merged headers, the cohort shaded cells.
    const flat = shapes.flat(2);
    expect(flat.some((r) => r.kind === 'is-subtotal')).toBe(true);
    expect(flat.some((r) => r.cells.some((x) => x.colSpan > 1))).toBe(true);
    expect(flat.some((r) => r.cells.some((x) => x.backgroundColor.startsWith('rgb')))).toBe(true);
    expect(flat.some((r) => r.cells.some((x) => x.kind.includes('is-above')))).toBe(true);
    expect(flat.some((r) => r.cells.some((x) => x.kind.includes('is-below')))).toBe(true);
  });

  it('a broken port would fail: a dropped subtotal class is seen', () => {
    const name = 'pivot / hierarchy, two values, scale + bars';
    const a = G.drawn[`${name}|true`]!.tables;
    const b = tables(drawPort('pivot', DATA[name]!, true), false);
    b[0]!.find((r) => r.kind === 'is-subtotal')!.kind = '';
    expect(b).not.toEqual(a);
  });
});

// ── Accessibility ────────────────────────────────────────────────────────────

describe('a11y: table headers and scope', () => {
  for (const [name, c] of Object.entries(CASES)) {
    if (name.includes('needs')) continue;
    it(name, () => {
      const root = drawPort(c.type, DATA[name]!, true);
      const all = [...root.querySelectorAll('table')];
      if (name === 'event funnel / sample') {
        // No breakdown: an ordered list of labelled steps, no table.
        expect(root.querySelectorAll('ol > li[aria-label]').length).toBe(3);
        return;
      }
      expect(all.length).toBeGreaterThan(0);
      for (const table of all) {
        for (const th of table.querySelectorAll('th')) {
          const scope = th.getAttribute('scope');
          if (th.closest('thead')) expect(scope, text(th)).toBe(th.colSpan > 1 ? 'colgroup' : 'col');
          else expect(scope, text(th)).toBe('row');
          // A header names something: its text, or a labelled control inside it.
          const named = text(th) !== '' || !!th.querySelector('[aria-label]') || !!th.querySelector('[class*="srOnly"], .' + P.srOnly);
          expect(named, th.outerHTML).toBe(true);
        }
        for (const tr of table.querySelectorAll('tbody tr, tfoot tr')) {
          if (tr.getAttribute('aria-hidden') === 'true') continue;
          expect(tr.firstElementChild?.tagName, 'every body row starts with its row header').toBe('TH');
        }
      }
      // The a11y tree: named tables with column and row headers.
      const named = screen.getAllByRole('table', { name: /\S/ });
      expect(named.length).toBe(screen.getAllByRole('table').length);
      const t0 = named[0]!;
      expect(within(t0).getAllByRole('columnheader').length).toBeGreaterThan(1);
      expect(within(t0).getAllByRole('rowheader').length).toBeGreaterThan(0);
    });
  }
});

// ── Behaviour ────────────────────────────────────────────────────────────────

describe('behaviour', () => {
  it('a header click asks for the server’s sort; the arrow follows the grid’s echo', () => {
    const name = 'pivot / three levels, avg, % of total, threshold, sorted';
    const onSort = vi.fn();
    render(<GridViz type="pivot" data={DATA[name]!} label="Grid" onSort={onSort} />);
    const sorted = screen.getByRole('button', { name: /descending$/ });
    fireEvent.click(sorted);
    expect(onSort).toHaveBeenLastCalledWith({ by: 1, dir: 'asc' });
    const corner = screen.getByRole('button', { name: 'Sort by label' });
    expect(corner.textContent).toContain('Label'); // a visible word, not an empty button
    fireEvent.click(corner);
    expect(onSort).toHaveBeenLastCalledWith({ by: 'label', dir: 'asc' });
  });

  it('collapsing a subtotal hides its children and keeps the subtotal', () => {
    const name = 'pivot / hierarchy, two values, scale + bars';
    const grid = DATA[name]!.pivot!;
    render(<GridViz type="pivot" data={DATA[name]!} label="Grid" onSort={() => {}} />);
    const before = screen.getAllByRole('row').length;
    const first = screen.getAllByRole('button', { name: /^Collapse / })[0]!;
    const region = first.textContent;
    fireEvent.click(first);
    const children = grid.rowHeaders.filter((p) => p.length > 1 && p[0] === region).length;
    expect(screen.getAllByRole('row').length).toBe(before - children);
    expect(screen.getByRole('button', { name: `Expand ${region}` })).toHaveProperty('ariaExpanded', 'false');
  });

  it('a read-only surface offers no sort or collapse control', () => {
    render(<GridViz type="pivot" data={DATA['pivot / hierarchy, two values, scale + bars']!} label="Grid" />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('above 200 rows the body is a window with spacers, not every row', () => {
    const n = 1500;
    const grid: PivotGridShape = {
      rowHeaders: Array.from({ length: n }, (_, i) => [`r${i}`]),
      colHeaders: [['v']],
      cells: Array.from({ length: n }, (_, i) => [i]),
      rowTotals: null, colTotals: null, grand: null,
      rowKinds: Array.from({ length: n }, () => 'leaf' as const),
      valueNames: ['v'], valueCount: 1, showAs: ['value'], formats: [''], conditional: [], sort: null,
      rowGroupCount: n, colGroupCount: 1, truncated: false,
    };
    const { container } = render(<GridViz type="pivot" data={{ labels: [], series: [], pivot: grid }} label="Big" />);
    const drawn = container.querySelectorAll('tbody tr:not([aria-hidden])').length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(100);
    expect(container.querySelectorAll('tbody tr[aria-hidden="true"]').length).toBe(1);
  });

  it('prints the server’s member total, never a sum of the sizes', () => {
    const data = structuredClone(DATA['cohort / retention table']!);
    data.cohort!.members = 999_999; // deliberately not the sum
    render(<GridViz type="cohort" data={data} label="Cohort" />);
    expect(screen.getByText(/1M members|999,999 members|1\.0M members/)).toBeTruthy();
    const avgRow = screen.getByRole('rowheader', { name: 'Average' }).closest('tr')!;
    expect(avgRow.children[1]!.textContent).not.toBe(String(data.cohort!.sizes.reduce((a, b) => a + b, 0)));
    expect(engineRows('cohort', data)!.at(-1)![1]).toBe('999999');
  });

  it('the cohort switches between its table and the retention curve', () => {
    render(<GridViz type="cohort" data={DATA['cohort / retention table']!} label="Cohort" />);
    expect(screen.getByRole('table', { name: 'Cohort' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retention curve' }));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('img', { name: /^Retention curve: \d+ cohorts/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retention curve' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('empty states say what is missing', () => {
    render(<GridViz type="cohort" data={DATA['cohort / needs a column']!} label="Cohort" />);
    expect(screen.getByRole('heading', { name: DATA['cohort / needs a column']!.cohort!.needs })).toBeTruthy();
    render(<GridViz type="pivot" data={{ labels: [], series: [] }} label="Pivot" />);
    expect(screen.getByRole('heading', { name: t('pivotRender.pick_a_row_dimension_and_at') })).toBeTruthy();
  });
});

describe('grid strings', () => {
  it('match src/i18n/en.json', () => {
    const EN = JSON.parse(readFileSync(path.join(ROOT, 'src', 'i18n', 'en.json'), 'utf8')) as Record<string, string>;
    for (const [key, msg] of Object.entries(GRID_STRINGS)) expect(msg, key).toBe(EN[key]);
  });
});
