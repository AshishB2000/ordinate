// The data table behind a result (renderer/hub/chartTable.ts) — the `table`
// chart id is a <table>, not a canvas. This is its model: each series' colour
// slot (DataTable.tsx paints the swatch with that --chart-N token in CSS, so it
// matches the series' colour in every chart and follows the theme by itself)
// and every cell as display text. React escapes text, so a label containing
// markup renders as text.
// ponytail: series colours from Format → Colours (fmtSeriesPalette) join in T2.3.

import * as OrdFormat from '../../../src/app/format.ts';
import { CHART_PALETTE } from './palette';
import { t } from './strings';
import type { ChartDataShape, ChartSeriesShape, Cx } from './types';

export interface TableModel {
  /** The first header cell. */
  labelHeader: string;
  /** `slot` is the series' chart colour: --chart-<slot + 1>, the token its swatch is painted with. */
  series: Array<{ name: string; slot: number }>;
  rows: Array<{ label: string; cells: string[] }>;
}

export function tableModel(data: ChartDataShape): TableModel {
  const labels: Cx[] = Array.isArray(data.labels) ? data.labels : [];
  const series: ChartSeriesShape[] = Array.isArray(data.series) ? data.series : [];
  return {
    labelHeader: t('common.label'),
    series: series.map((s, si) => ({ name: s.name || '', slot: si % CHART_PALETTE.length })),
    rows: labels.map((label, i) => ({
      label: label == null ? '' : String(label),
      cells: series.map((s) => {
        const v = s.values ? s.values[i] : null;
        return typeof v === 'number' ? OrdFormat.formatNumber(v, { maxDecimals: 2 }) : v != null ? String(v) : '';
      }),
    })),
  };
}
