// Chart.js and its family plugins, loaded on FIRST USE (the desktop's
// lazyScript.ts idea, with a bundler): the core the first time any chart
// draws, each plugin the first time its family does. None of it is in the
// initial chunk. Keyed by the resolved Chart.js type (typeSpec.ts).

import type { Chart } from 'chart.js';

export type ChartClass = typeof Chart;

let core: Promise<ChartClass> | undefined;

const PLUGINS: Record<string, (C: ChartClass) => Promise<void>> = {
  treemap: async (C) => {
    const m = await import('chartjs-chart-treemap');
    C.register(m.TreemapController, m.TreemapElement);
  },
  matrix: async (C) => {
    const m = await import('chartjs-chart-matrix');
    C.register(m.MatrixController, m.MatrixElement);
  },
  sankey: async (C) => {
    const m = await import('chartjs-chart-sankey');
    C.register(m.SankeyController, m.Flow);
  },
  candlestick: async (C) => {
    const m = await import('chartjs-chart-financial');
    C.register(m.CandlestickController, m.CandlestickElement);
  },
  boxplot: async (C) => {
    const m = await import('@sgratzl/chartjs-chart-boxplot');
    C.register(m.BoxPlotController, m.BoxAndWiskers);
  },
};
const plugins = new Map<string, Promise<void>>();

/** A failed import is not cached: the next chart tries again. */
function once<T>(get: () => Promise<T> | undefined, set: (p: Promise<T> | undefined) => void, load: () => Promise<T>): Promise<T> {
  let p = get();
  if (!p) {
    p = load().catch((err: unknown) => {
      set(undefined);
      throw err;
    });
    set(p);
  }
  return p;
}

/** The Chart.js class with every controller `chartType` needs registered. */
export async function loadChartJs(chartType: string): Promise<ChartClass> {
  const C = await once(
    () => core,
    (p) => {
      core = p;
    },
    async () => {
      const m = await import('chart.js');
      m.Chart.register(...m.registerables);
      return m.Chart;
    },
  );
  const plugin = PLUGINS[chartType];
  if (plugin) {
    await once(
      () => plugins.get(chartType),
      (p) => {
        if (p) plugins.set(chartType, p);
        else plugins.delete(chartType);
      },
      () => plugin(C),
    );
  }
  return C;
}
