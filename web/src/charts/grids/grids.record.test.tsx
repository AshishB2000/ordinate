// ONE-OFF RECORDER (T8.1) for grids.test.tsx: the desktop's pivotRender.js /
// cohortRender.js drawing that test's server replies (the sample dataset through
// parseFile + buildVizData) in jsdom, read back the test's way, written with the
// replies to __golden__/grids.json. Runs only with GOLDEN_RECORD=1; deleted
// with the desktop tree in the next commit.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { encode } from '../../../../src/server/wire.ts';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { beforeAll, describe, it, vi } from 'vitest';
import { SAMPLE_ENCODINGS } from '../sampleEncodings';
import type { Cx } from '../types';
import E from './Engine.module.css';
import type { GridData } from './GridViz';
import P from './Pivot.module.css';

const ROOT = path.resolve(process.cwd(), '..');
const HUB = path.join(ROOT, 'renderer', 'hub');
const require = createRequire(path.join(ROOT, 'package.json'));

// The tokens both sides read (the cohort ramp mixes --surface → --accent).
const THEME: Record<string, string> = { '--surface': '#ffffff', '--accent': '#2563eb', '--text': '#374151', '--text-strong': '#0f1117' };
vi.mock('../palette', () => ({ getCSSVar: (name: string) => THEME[name] ?? '' }));

// ── The desktop side ─────────────────────────────────────────────────────────

interface Legacy {
  renderPivotTable(el: HTMLElement, grid: unknown, opts?: unknown): void;
  renderEngineViz(el: HTMLElement, data: unknown, type: string, source?: unknown): void;
}

function slice(file: string, from: string, to: string): string {
  const src = readFileSync(path.join(HUB, file), 'utf8');
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`${file}: markers not found — has it changed shape?`);
  return src.slice(a, b);
}

function loadLegacy(): Legacy {
  const sandbox: Record<string, unknown> = {
    console,
    document,
    requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
    OrdFormat: require(path.join(ROOT, 'src/app/format.js')),
    t: (require(path.join(ROOT, 'scripts/i18nNode.js')) as { englishT: unknown }).englishT,
    getCSSVar: (name: string) => THEME[name] ?? '',
    icon: () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
    VIZ_ICONS: {},
    chartInstances: new Map(),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const source = [
    slice('hub.js', 'function _fmtVal(', '// ── Readiness banner'),
    readFileSync(path.join(HUB, 'calcMenu.js'), 'utf8'),
    readFileSync(path.join(HUB, 'pivotRender.js'), 'utf8'),
    readFileSync(path.join(HUB, 'cohortRender.js'), 'utf8'),
  ].join('\n;\n');
  return vm.runInContext(`${source}\n;({ renderPivotTable, renderEngineViz });`, sandbox, { filename: 'legacy-grids.js' }) as Legacy;
}

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

const DATA: Record<string, GridData> = {};
let legacy: Legacy;

beforeAll(async () => {
  if (!process.env.GOLDEN_RECORD) return;
  const { parseFile } = require(path.join(ROOT, 'src/data/fileImport.js'));
  const { buildVizData } = require(path.join(ROOT, 'src/analysis/vizData.js'));
  const { sanitizeEncoding } = require(path.join(ROOT, 'src/analysis/visuals.js'));
  const parsed = await parseFile(path.join(ROOT, 'assets/samples/retail-orders.csv'), 'csv');
  for (const [name, c] of Object.entries(CASES)) {
    const r = buildVizData(parsed.columns, parsed.rows, sanitizeEncoding(c.encoding), []);
    DATA[name] = r.data;
  }
  legacy = loadLegacy();
});

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
            title: legacySide && cell.classList.contains('pivot-cell') ? legacyTip(cell) : cell.title,
          };
        }),
      })),
  );
}

/**
 * The desktop pivot's hover tooltip, as the lines it shows — the port's
 * `title`. Its "N% of total" line is a share the desktop worked out in the
 * renderer; the port drops it (the server does the math), so it is left out.
 */
function legacyTip(td: HTMLElement): string {
  td.dispatchEvent(new MouseEvent('mouseenter'));
  const tip = document.querySelector('.pivot-tip');
  const lines = tip ? [...tip.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '') : [];
  td.dispatchEvent(new MouseEvent('mouseleave'));
  return lines.filter((l) => !/% of total$/.test(l)).join('\n');
}

function funnelSteps(root: HTMLElement) {
  return [...root.querySelectorAll('li')].map((li) => ({
    label: li.getAttribute('aria-label'),
    text: text(li),
    width: (li.querySelector('[aria-hidden="true"] > div') as HTMLElement | null)?.style.width,
  }));
}

function drawLegacy(type: string, data: GridData, interactive: boolean): HTMLElement {
  const host = document.createElement('div');

  if (type === 'pivot') legacy.renderPivotTable(host, data.pivot, interactive ? { onSort: () => {} } : {});
  else legacy.renderEngineViz(host, data, type, null);
  return host;
}


describe.runIf(process.env.GOLDEN_RECORD)('record the desktop grids', () => {
  it('writes __golden__/grids.json', () => {
    const drawn: Record<string, unknown> = {};
    for (const [name, c] of Object.entries(CASES)) {
      for (const interactive of c.type === 'pivot' ? [true, false] : [true]) {
        const old = drawLegacy(c.type, DATA[name]!, interactive);
        drawn[`${name}|${interactive}`] = { tables: tables(old, true), text: text(old), funnel: funnelSteps(old) };
        old.remove();
      }
    }
    const out = path.join(process.cwd(), 'src/charts/grids/__golden__');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'grids.json'), encode({ data: DATA, drawn }) + '\n');
  });
});
