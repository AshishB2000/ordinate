// THE DIFFERENTIAL TEST for the chart engine: the desktop's builders (its
// chart*.ts classic scripts) and this port, run on the SAME data, must produce
// the same Chart.js config — for all 39 chart ids, under three override sets.
//
//   data       the sample dataset (assets/samples/retail-orders.csv) through
//              the server's own parseFile + buildVizData — what `visual:data`
//              answers for each id's encoding (sampleEncodings.ts)
//   legacy     what the desktop's scripts built from that data (with hub.js's
//              own formatters, the real app formatter and the English catalog),
//              recorded with the data at the T8.1 cutover, when they went:
//              __golden__/legacy.json
//   port       buildChart() from ./build, on the same canvas stub and tokens
//
// Compared after normalising both sides into plain data: functions by
// presence and name (Chart.js callbacks and plugin hooks — their bodies are a
// port of the same code, not the same code), everything else deep-equal with
// Object.is at the leaves. One known divergence, pinned below: a candlestick's
// x is its label INDEX in the port (the desktop's label text drops every
// candle — see datasets.ts).
//
// Plus: the data table, the word cloud's input and layout, and VIZ_LABELS.

import { deepStrictEqual, notDeepStrictEqual } from 'node:assert/strict';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { golden } from '../test-golden';
import { buildChart } from './build';
import { tableModel } from './table';
import type { ChartDataShape, Cx } from './types';
import { VIZ_IDS, VIZ_LABELS } from './vizLabels';
import { wordCloudLayout } from './wordCloudLayout';

// Light-theme tokens — the same on every run and both sides.
const THEME: Record<string, string> = {
  '--chart-1': '#2563eb', '--chart-2': '#0e7490', '--chart-3': '#14b8a6', '--chart-4': '#6366f1',
  '--chart-5': '#64748b', '--chart-6': '#b45309', '--chart-7': '#be185d', '--chart-8': '#4d7c0f',
  '--muted': '#6b7280', '--border': '#e5e7eb', '--surface': '#ffffff', '--text-strong': '#0f1117',
  '--font-ui': 'Inter, system-ui, sans-serif', '--accent': '#2563eb', '--ok': '#059669', '--error': '#e11d48',
};
const computedStyle = () => ({ getPropertyValue: (name: string) => THEME[name] || '' });

// The canvas both sides draw "into": a calendar sizes its bands off the parent.
const canvasStub = () => ({ parentElement: { clientWidth: 640, clientHeight: 320 } }) as unknown as HTMLCanvasElement;

// The three override sets of scripts/test-chartSpec.ts: first draw, Customize
// turned all the way up, and the filtered / export shape.
const OVERRIDES: Record<string, Record<string, unknown>> = {
  default: {},
  custom: {
    title: 'Revenue by region', color: '#ff6600', valueMode: 'all',
    showGridlines: false, xAxisLabel: 'Region', yAxisLabel: 'Revenue',
    sort: 'desc', yZero: true, numberFormat: 'currency', smooth: false,
    legendPosition: 'right', showLegend: true,
  },
  filtered: {
    hiddenSeries: [1], valueMode: 'min', showLegend: false, periodIdx: 0,
    noAnimate: true, devicePixelRatio: 2, showTooltips: false, yZero: false,
  },
};

// ── Normalising ──────────────────────────────────────────────────────────────

/** Desktop globals that are module exports here under a name without the global-scope underscore. */
const RENAMED: Record<string, string> = { _fmtVal: 'fmtVal' };

/** Plain data in THIS realm: functions → {fn: name}, keys in order, Sets as sorted lists. */
function norm(v: unknown, depth = 0): unknown {
  if (depth > 40) throw new Error('too deep — a cycle?');
  if (typeof v === 'function') {
    const name = (v as { name: string }).name;
    return { fn: RENAMED[name] ?? name };
  }
  if (v === null || typeof v !== 'object') return v;
  // Array.from, not .map: a vm-realm array's .map builds another vm-realm array.
  if (Array.isArray(v)) return Array.from(v, (x) => norm(x, depth + 1));
  if (Object.prototype.toString.call(v) === '[object Set]') return { set: Array.from(v as Set<unknown>, (x) => norm(x, depth + 1)) };
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) out[k] = norm((v as Record<string, unknown>)[k], depth + 1);
  return out;
}

// ── The recorded desktop side, and the data it was given ─────────────────────

const G = golden<{
  data: Record<string, ChartDataShape>;
  configs: Record<string, null | { wordCloud: Cx } | { config: Cx; count: number }>;
  decorated: Record<string, ChartDataShape>;
  overlays: Record<string, Cx>;
  dataTable: { labelHeader: string; series: Array<{ name: string; color: string }>; rows: Array<{ label: string; cells: string[] }> };
  wordCloud: { words: Array<{ text: string; weight: number }>; layout: Cx };
  vizLabels: Cx;
}>('src/charts/__golden__/legacy.json');
const DATA = new Map<string, ChartDataShape>(Object.entries(G.data));

beforeAll(() => {
  vi.stubGlobal('getComputedStyle', computedStyle);
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const copy = <T,>(v: T): T => structuredClone(v);

describe('the port builds the desktop config, id by id', () => {
  it('has the 39 chart ids, every one with sample data', () => {
    expect(VIZ_IDS).toHaveLength(39);
    for (const id of VIZ_IDS) expect((DATA.get(id)?.labels ?? []).length, id).toBeGreaterThan(0);
    expect(Object.keys(G.configs)).toHaveLength(39 * Object.keys(OVERRIDES).length);
  });

  for (const variant of Object.keys(OVERRIDES)) {
    for (const id of VIZ_IDS) {
      it(`${id} / ${variant}`, () => {
        const data = DATA.get(id)!;
        const old = G.configs[`${id} / ${variant}`];
        expect(old, 'recorded').not.toBeUndefined();
        const built = buildChart(canvasStub(), copy(data), id, copy(OVERRIDES[variant]));
        if (old === null) {
          expect(built).toBeNull();
          return;
        }
        expect(built, 'the port drew nothing where the desktop drew').not.toBeNull();
        if (built!.kind === 'wordCloud') {
          expect('wordCloud' in old!).toBe(true);
          const { labels, series, overrides, theme } = built!;
          deepStrictEqual(norm({ labels, series, overrides, theme }), (old as { wordCloud: Cx }).wordCloud);
          return;
        }
        expect((old as { count: number }).count).toBe(1);
        const want = copy((old as { config: Cx }).config);
        const got = norm(built!.config) as Cx;
        if (id === 'candlestick') {
          // The one divergence: x is the label index, not its text.
          const labels = DATA.get(id)!.labels ?? [];
          want.data.datasets[0].data.forEach((p: Cx, i: number) => {
            expect(p.x).toBe(String(labels[i]));
            p.x = i;
          });
        }
        deepStrictEqual(got, want);
      });
    }
  }

  // Overlays, comment pins and events, on the ids that draw them: the
  // annotation and events plugins carry their whole input (`config`, `events`).
  for (const id of ['line', 'column', 'combo', 'bar', 'histogram', 'scatter', 'candlestick'] as const) {
    for (const variant of ['default', 'custom'] as const) {
      it(`${id} / ${variant} with overlays, pins and events`, () => {
        const data = copy(G.decorated[id]!);
        expect((data.analytics ?? []).length).toBe(8);
        const overrides = {
          ...OVERRIDES[variant],
          commentPins: [{ n: 1, id: 'p1', label: String(data.labels![1]) }],
          commentPinTarget: { kind: 'visual', id: 'v1' },
        };
        const built = buildChart(canvasStub(), copy(data), id, copy(overrides));
        expect(built?.kind).toBe('chartjs');
        const want = copy(G.overlays[`${id} / ${variant}`]) as Cx;
        const got = norm(built!.kind === 'chartjs' ? built!.config : null) as Cx;
        if (id === 'candlestick') for (const [i, p] of (want.data.datasets[0].data as Cx[]).entries()) p.x = i;
        const ids = (got.plugins as Cx[]).map((p) => p.id);
        expect(ids).toContain('ordAnnotations');
        deepStrictEqual(got, want);
      });
    }
  }
  it('events reach the plugin where the axis is a date', () => {
    const built = buildChart(canvasStub(), copy(G.decorated.line!), 'line', {});
    const ev = built?.kind === 'chartjs' ? built.config.plugins.find((p: Cx) => p.id === 'ordEvents') : null;
    expect(ev?.events).toHaveLength(2);
  });

  it('compares something: two different ids give different configs', () => {
    const a = buildChart(canvasStub(), copy(DATA.get('column')!), 'column', {});
    const b = buildChart(canvasStub(), copy(DATA.get('line')!), 'line', {});
    notDeepStrictEqual(norm(a), norm(b));
  });

  it('a broken port would be caught (negative control)', () => {
    const built = buildChart(canvasStub(), copy(DATA.get('column')!), 'column', copy(OVERRIDES.custom));
    const want = (G.configs['column / default'] as { config: Cx }).config;
    expect(() => deepStrictEqual(norm(built!.kind === 'chartjs' ? built!.config : null), want)).toThrow();
  });
});

describe('the rest of the engine matches the desktop', () => {
  it('the data table: header, swatch colours and every cell', () => {
    const data = DATA.get('table')!;
    const m = tableModel(copy(data));
    expect(m.labelHeader).toBe(G.dataTable.labelHeader);
    deepStrictEqual(m.series.map((c) => ({ name: c.name, color: THEME[`--chart-${c.slot + 1}`] })), G.dataTable.series);
    deepStrictEqual(m.rows, G.dataTable.rows);
    expect(m.rows.length).toBeGreaterThan(0);
  });

  it('the word cloud layout: every word in the same place', () => {
    const data = DATA.get('word_cloud')!;
    const words = (data.labels ?? []).map((l: Cx, i: number) => ({ text: String(l), weight: data.series![0]!.values[i] }));
    deepStrictEqual(words, G.wordCloud.words);
    const opts = { width: 600, height: 300, minSize: 11, maxSize: 56, measure: (s: string, px: number) => s.length * px * 0.55, padding: 2 };
    const got = wordCloudLayout(copy(words), opts);
    expect(got.placed.length).toBeGreaterThan(5);
    deepStrictEqual(norm(got), G.wordCloud.layout);
  });

  it('VIZ_LABELS: the same 39 ids and names', () => {
    deepStrictEqual(norm(VIZ_LABELS), G.vizLabels);
  });
});
